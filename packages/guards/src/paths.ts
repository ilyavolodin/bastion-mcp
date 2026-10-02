/**
 * Path addressing for text segments and regex rule scopes (13.3, 13.4).
 * Segment paths look like `content[2].text`, `arguments.query`, `arguments.rows[0]["a.b"]`.
 * Rule patterns add `*` (one key or index), `[*]` (any index) and `**` (any number of steps).
 */

export type PathToken =
  | { kind: 'key'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'any' }
  | { kind: 'anyIndex' }
  | { kind: 'deep' };

const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export const joinKey = (prefix: string, key: string): string => {
  if (SIMPLE_KEY.test(key)) return prefix === '' ? key : `${prefix}.${key}`;
  return `${prefix}[${JSON.stringify(key)}]`;
};

export const joinIndex = (prefix: string, index: number): string => `${prefix}[${index}]`;

/** Parses a segment path or a rule pattern. Throws on malformed input. */
export const parsePath = (path: string): PathToken[] => {
  const tokens: PathToken[] = [];
  let i = 0;
  const n = path.length;
  while (i < n) {
    const ch = path.charAt(i);
    if (ch === '.') {
      i++;
      continue;
    }
    if (ch === '[') {
      if (path.charAt(i + 1) === '"') {
        let j = i + 2;
        while (j < n && !(path.charAt(j) === '"' && path.charAt(j - 1) !== '\\')) j++;
        if (j >= n || path.charAt(j + 1) !== ']') throw new SyntaxError(`bad path: ${path}`);
        const raw = path.slice(i + 1, j + 1);
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'string') throw new SyntaxError(`bad path: ${path}`);
        tokens.push({ kind: 'key', value: parsed });
        i = j + 2;
        continue;
      }
      const close = path.indexOf(']', i);
      if (close < 0) throw new SyntaxError(`bad path: ${path}`);
      const inner = path.slice(i + 1, close);
      if (inner === '*') tokens.push({ kind: 'anyIndex' });
      else if (/^\d+$/.test(inner)) tokens.push({ kind: 'index', value: Number(inner) });
      else throw new SyntaxError(`bad path: ${path}`);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < n && path.charAt(j) !== '.' && path.charAt(j) !== '[') j++;
    const word = path.slice(i, j);
    if (word === '**') tokens.push({ kind: 'deep' });
    else if (word === '*') tokens.push({ kind: 'any' });
    else tokens.push({ kind: 'key', value: word });
    i = j;
  }
  return tokens;
};

const tokenMatches = (pattern: PathToken, actual: PathToken): boolean => {
  switch (pattern.kind) {
    case 'any':
      return true;
    case 'anyIndex':
      return actual.kind === 'index';
    case 'key':
      return actual.kind === 'key' && actual.value === pattern.value;
    case 'index':
      return actual.kind === 'index' && actual.value === pattern.value;
    case 'deep':
      return true;
  }
};

const matchFrom = (
  pattern: readonly PathToken[],
  pi: number,
  actual: readonly PathToken[],
  ai: number,
): boolean => {
  if (pi === pattern.length) return ai === actual.length;
  const p = pattern[pi];
  if (p === undefined) return false;
  if (p.kind === 'deep') {
    for (let skip = ai; skip <= actual.length; skip++) {
      if (matchFrom(pattern, pi + 1, actual, skip)) return true;
    }
    return false;
  }
  const a = actual[ai];
  if (a === undefined || !tokenMatches(p, a)) return false;
  return matchFrom(pattern, pi + 1, actual, ai + 1);
};

export const compilePathPattern = (pattern: string): ((segmentPath: string) => boolean) => {
  const tokens = parsePath(pattern);
  const cache = new Map<string, boolean>();
  return (segmentPath) => {
    const hit = cache.get(segmentPath);
    if (hit !== undefined) return hit;
    const result = matchFrom(tokens, 0, parsePath(segmentPath), 0);
    if (cache.size < 4096) cache.set(segmentPath, result);
    return result;
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const step = (node: unknown, token: PathToken): unknown => {
  if (token.kind === 'key' && isRecord(node)) {
    return Object.hasOwn(node, token.value) ? node[token.value] : undefined;
  }
  if (token.kind === 'index' && Array.isArray(node)) return node[token.value];
  return undefined;
};

export const getAtPath = (root: unknown, path: string): unknown => {
  let node: unknown = root;
  for (const token of parsePath(path)) {
    node = step(node, token);
    if (node === undefined) return undefined;
  }
  return node;
};

/** Returns a copy of `root` with the value at `path` replaced; unchanged when the path is absent. */
export const setAtPath = (root: unknown, path: string, value: unknown): unknown => {
  const tokens = parsePath(path);
  const go = (node: unknown, i: number): unknown => {
    const token = tokens[i];
    if (token === undefined) return value;
    if (token.kind === 'key' && isRecord(node) && Object.hasOwn(node, token.value)) {
      return { ...node, [token.value]: go(node[token.value], i + 1) };
    }
    if (token.kind === 'index' && Array.isArray(node) && token.value < node.length) {
      const copy = node.slice();
      copy[token.value] = go(node[token.value], i + 1);
      return copy;
    }
    return node;
  };
  return go(root, 0);
};
