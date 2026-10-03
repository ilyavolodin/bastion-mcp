/** How many requests of a fan-out run at once. */
export const FAN_OUT = 6;

/**
 * Maps `items` through `fn`, at most `size` calls in flight (each batch settles before the next starts). The result
 * keeps the order of `items`. A rejection of `fn` rejects the whole call, so callers that tolerate a failing item
 * catch inside `fn`.
 */
export async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const step = Math.max(1, Math.floor(size));
  const out: R[] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(...(await Promise.all(items.slice(i, i + step).map((item, j) => fn(item, i + j)))));
  }
  return out;
}
