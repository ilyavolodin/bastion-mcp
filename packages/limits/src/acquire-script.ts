/**
 * Text of `lua/acquire.lua`, bundled as a constant so bundlers need not read files at runtime.
 * A test keeps the two identical.
 */
export const ACQUIRE_LUA = `-- Sorted-set semaphore (14.2). Members are request ids scored by lease expiry (epoch ms).
-- KEYS[1] = conc:{ruleId}:{subjectId}
-- ARGV[1] = now (ms), ARGV[2] = lease expiry (ms), ARGV[3] = max, ARGV[4] = request id
-- Returns {acquired (1|0), in-flight count after the call}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[3]) then
  return {0, count}
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return {1, count + 1}`;
