import { ScimError } from './types';

export type FilterValue = string | number | boolean | null;

export type FilterNode =
  | { op: 'and' | 'or'; left: FilterNode; right: FilterNode }
  | { op: 'not'; operand: FilterNode }
  | { op: 'eq' | 'ne' | 'co' | 'sw' | 'ew'; attr: string; value: FilterValue }
  | { op: 'pr'; attr: string };

type Token =
  | { kind: 'lparen' | 'rparen' }
  | { kind: 'word'; text: string }
  | { kind: 'string'; text: string };

const invalid = (detail: string) => new ScimError(400, detail, 'invalidFilter');

const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
    } else if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < input.length && (escaped || input.charAt(j) !== '"')) {
        escaped = !escaped && input.charAt(j) === '\\';
        j++;
      }
      if (j >= input.length) throw invalid('unterminated string in filter');
      try {
        tokens.push({ kind: 'string', text: JSON.parse(input.slice(i, j + 1)) as string });
      } catch {
        throw invalid('invalid string escape in filter');
      }
      i = j + 1;
    } else {
      let j = i;
      while (j < input.length && !/[\s()"]/.test(input.charAt(j))) j++;
      tokens.push({ kind: 'word', text: input.slice(i, j) });
      i = j;
    }
  }
  return tokens;
};

const ATTR = /^[A-Za-z][A-Za-z0-9_$.:-]*$/;
const MAX_FILTER_LENGTH = 1000;
const MAX_DEPTH = 20;

/** Parses the SCIM filter subset Okta and Entra send: eq, ne, co, sw, ew, pr, and, or, not, parentheses. */
export const parseScimFilter = (input: string): FilterNode => {
  if (input.length > MAX_FILTER_LENGTH) throw invalid('filter is too long');
  const tokens = tokenize(input);
  let pos = 0;
  const peekWord = (): string | undefined => {
    const t = tokens[pos];
    return t?.kind === 'word' ? t.text.toLowerCase() : undefined;
  };

  const parseOr = (depth: number): FilterNode => {
    if (depth > MAX_DEPTH) throw invalid('filter is nested too deeply');
    let left = parseAnd(depth);
    while (peekWord() === 'or') {
      pos++;
      left = { op: 'or', left, right: parseAnd(depth) };
    }
    return left;
  };
  const parseAnd = (depth: number): FilterNode => {
    let left = parseUnary(depth);
    while (peekWord() === 'and') {
      pos++;
      left = { op: 'and', left, right: parseUnary(depth) };
    }
    return left;
  };
  const parseUnary = (depth: number): FilterNode => {
    if (peekWord() === 'not') {
      pos++;
      return { op: 'not', operand: parseUnary(depth + 1) };
    }
    const t = tokens[pos];
    if (t?.kind === 'lparen') {
      pos++;
      const inner = parseOr(depth + 1);
      if (tokens[pos]?.kind !== 'rparen') throw invalid('missing closing parenthesis');
      pos++;
      return inner;
    }
    return parseComparison();
  };
  const parseComparison = (): FilterNode => {
    const attrTok = tokens[pos++];
    if (attrTok?.kind !== 'word' || !ATTR.test(attrTok.text)) throw invalid('expected attribute');
    const opTok = tokens[pos++];
    if (opTok?.kind !== 'word') throw invalid('expected operator');
    const op = opTok.text.toLowerCase();
    const attr = attrTok.text;
    if (op === 'pr') return { op: 'pr', attr };
    if (op !== 'eq' && op !== 'ne' && op !== 'co' && op !== 'sw' && op !== 'ew') {
      throw invalid(`unsupported operator ${opTok.text}`);
    }
    const v = tokens[pos++];
    if (!v) throw invalid('expected value');
    if (v.kind === 'string') return { op, attr, value: v.text };
    if (v.kind === 'word') {
      const w = v.text.toLowerCase();
      if (w === 'true') return { op, attr, value: true };
      if (w === 'false') return { op, attr, value: false };
      if (w === 'null') return { op, attr, value: null };
      if (/^-?\d+(\.\d+)?$/.test(w)) return { op, attr, value: Number(w) };
    }
    throw invalid('invalid filter value');
  };

  if (tokens.length === 0) throw invalid('empty filter');
  const node = parseOr(0);
  if (pos !== tokens.length) throw invalid('unexpected token in filter');
  return node;
};

const resolve = (resource: Record<string, unknown>, attr: string): unknown => {
  let current: unknown = resource;
  for (const part of attr.toLowerCase().split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    const entry = Object.entries(current).find(([k]) => k.toLowerCase() === part);
    current = entry?.[1];
  }
  return current;
};

const str = (v: unknown): string => String(v).toLowerCase();

/** In-memory evaluation (used by simple stores and tests); string comparison is case-insensitive. */
export const evaluateFilter = (node: FilterNode, resource: Record<string, unknown>): boolean => {
  switch (node.op) {
    case 'and':
      return evaluateFilter(node.left, resource) && evaluateFilter(node.right, resource);
    case 'or':
      return evaluateFilter(node.left, resource) || evaluateFilter(node.right, resource);
    case 'not':
      return !evaluateFilter(node.operand, resource);
    case 'pr': {
      const v = resolve(resource, node.attr);
      return v !== undefined && v !== null && v !== '';
    }
    default: {
      const v = resolve(resource, node.attr);
      if (node.op === 'eq')
        return node.value === null ? v == null : v != null && str(v) === str(node.value);
      if (node.op === 'ne')
        return node.value === null ? v != null : v == null || str(v) !== str(node.value);
      if (v == null) return false;
      const a = str(v);
      const b = str(node.value);
      return node.op === 'co' ? a.includes(b) : node.op === 'sw' ? a.startsWith(b) : a.endsWith(b);
    }
  }
};

/** `attr eq "value"` on one attribute, for stores that translate to an indexed lookup. */
export const simpleEquality = (
  node: FilterNode | null,
): { attr: string; value: FilterValue } | null =>
  node && node.op === 'eq' ? { attr: node.attr.toLowerCase(), value: node.value } : null;
