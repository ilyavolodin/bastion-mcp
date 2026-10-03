/** Returns the value cached under `key`, creating and storing it with `make` on first use. */
export const memoize = <K, V>(cache: Map<K, V>, key: K, make: () => V): V => {
  let value = cache.get(key);
  if (value === undefined) {
    value = make();
    cache.set(key, value);
  }
  return value;
};
