/**
 * The Lua scripts of the owner lease protocol (21.2) as TS string constants. The same text lives under `lua/` for
 * review and for Redis Cluster hash-tag audits; a test keeps the two in sync.
 */

/** Deletes `KEYS[1]` only when it still holds `ARGV[1]`. */
export const COMPARE_AND_DELETE = `-- KEYS[1] lease key, ARGV[1] expected owner. Deletes only when the value still matches (21.2).
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/** Renews `KEYS[1]` for `ARGV[2]` ms only when it still holds `ARGV[1]`. */
export const COMPARE_AND_PEXPIRE = `-- KEYS[1] lease key, ARGV[1] expected owner, ARGV[2] ttl in ms. Renews only a lease we still own (21.2).
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

/** Decrements a counter and never lets it go below zero. */
export const DECR_FLOOR = `-- KEYS[1] counter. Decrements but never goes below zero (listen reference counts, in-flight counters).
local value = redis.call('decr', KEYS[1])
if value < 0 then
  redis.call('set', KEYS[1], 0)
  return 0
end
return value
`;
