-- KEYS[1] lease key, ARGV[1] expected owner. Deletes only when the value still matches (21.2).
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
