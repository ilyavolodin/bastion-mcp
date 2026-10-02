/** Tiny LCS diff used by the definition diff views (12.5, 13.6). Inputs are small (definitions). */
export type DiffOp = { type: 'equal' | 'add' | 'del'; text: string };

const lcsTable = (a: string[], b: string[]): number[][] => {
  const t: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = t[i] as number[];
      const next = t[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return t;
};

/** One op per input element, in order. */
const diffSeq = (a: string[], b: string[]): DiffOp[] => {
  const t = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] as string });
      i++;
      j++;
    } else if (((t[i + 1] as number[])[j] ?? 0) >= ((t[i] as number[])[j + 1] ?? 0)) {
      ops.push({ type: 'del', text: a[i++] as string });
    } else {
      ops.push({ type: 'add', text: b[j++] as string });
    }
  }
  while (i < a.length) ops.push({ type: 'del', text: a[i++] as string });
  while (j < b.length) ops.push({ type: 'add', text: b[j++] as string });
  return ops;
};

const merge = (ops: DiffOp[]): DiffOp[] => {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ ...op });
  }
  return out;
};

const words = (s: string) => s.split(/(\s+)/).filter((x) => x !== '');

/** Word-level diff; whitespace tokens ride along with the neighbouring change. */
export const diffWords = (a: string, b: string): DiffOp[] => merge(diffSeq(words(a), words(b)));

export type SideRow = {
  left: string | null;
  right: string | null;
  kind: 'equal' | 'changed' | 'added' | 'removed';
};

/** Line diff arranged for a side-by-side view; adjacent removed and added lines pair up as "changed". */
export function diffLines(a: string, b: string): SideRow[] {
  const lines = diffSeq(a.split('\n'), b.split('\n'));
  const rows: SideRow[] = [];
  let k = 0;
  while (k < lines.length) {
    const cur = lines[k] as DiffOp;
    if (cur.type === 'equal') {
      rows.push({ left: cur.text, right: cur.text, kind: 'equal' });
      k++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < lines.length && (lines[k] as DiffOp).type !== 'equal') {
      const l = lines[k] as DiffOp;
      (l.type === 'del' ? dels : adds).push(l.text);
      k++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let x = 0; x < n; x++) {
      const left = dels[x] ?? null;
      const right = adds[x] ?? null;
      rows.push({
        left,
        right,
        kind: left !== null && right !== null ? 'changed' : left !== null ? 'removed' : 'added',
      });
    }
  }
  return rows;
}

/** Stable, pretty JSON (sorted keys) so equal definitions diff as equal. */
export const stableStringify = (value: unknown): string =>
  JSON.stringify(sortKeys(value), null, 2) ?? 'null';

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
};
