-- KEYS[1] lease key, ARGV[1] expected owner, ARGV[2] ttl in ms. Renews only a lease we still own (21.2).
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
