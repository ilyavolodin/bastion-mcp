/** Latency histogram math of the call-log rollups (15.5); the implementation lives in `@bastion-mcp/core`. */
export {
  emptyBuckets,
  FINITE_BOUNDS_MS,
  isErrorOutcome,
  LATENCY_BUCKET_COUNT,
  LATENCY_UPPER_BOUNDS_MS,
  latencyBucketIndex,
  mergeBuckets,
  percentileFromBuckets,
} from '@bastion-mcp/core';
