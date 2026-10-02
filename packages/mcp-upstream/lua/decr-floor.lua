-- KEYS[1] counter. Decrements but never goes below zero (listen reference counts, in-flight counters).
local value = redis.call('decr', KEYS[1])
if value < 0 then
  redis.call('set', KEYS[1], 0)
  return 0
end
return value
