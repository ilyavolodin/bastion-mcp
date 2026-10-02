/**
 * The ports of this package are satisfied by the real implementations of the sibling packages: these assignments are
 * checked by `tsc` (and run trivially), so `apps/server` can pass the real objects without adapters.
 */
import type { TokenVerifier } from '@bastion-mcp/auth';
import type { Limiter } from '@bastion-mcp/limits';
import type {
  InternalRpcClient,
  UpstreamLists,
  UpstreamService,
  WorkerRegistry,
} from '@bastion-mcp/mcp-upstream';
import type { PolicyEngine } from '@bastion-mcp/policy';
import type { UpstreamItemSource } from '@bastion-mcp/router';
import type { CallLogWriter } from '@bastion-mcp/telemetry';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { ReadCachePort } from '../src/operations/deps';
import type {
  CallLogPort,
  DownstreamRedis,
  PolicyPort,
  SessionResponseForwarder,
  TokenVerifierPort,
  UpstreamPort,
  WorkerDirectory,
} from '../src/ports';

describe('port assignability', () => {
  it('6.2 an ioredis client satisfies DownstreamRedis (sessions, pend keys and pub/sub), and the auth, upstream and telemetry objects satisfy the other ports', () => {
    const redis = new Redis({ lazyConnect: true });
    const downstream: DownstreamRedis = redis;
    expect(typeof downstream.duplicate).toBe('function');
    redis.disconnect();

    const assertions = (
      verifier: TokenVerifier,
      engine: PolicyEngine,
      writer: CallLogWriter,
      registry: WorkerRegistry,
      rpc: InternalRpcClient,
      lists: UpstreamLists,
      service: UpstreamService,
      limiter: Limiter,
    ) => {
      const ports: [
        TokenVerifierPort,
        PolicyPort['current'] extends () => infer R ? R : never,
        CallLogPort,
        WorkerDirectory,
        SessionResponseForwarder,
        ReadCachePort,
        UpstreamItemSource,
        Pick<UpstreamPort, 'execute' | 'executeTask'>,
        Limiter,
      ] = [verifier, engine, writer, registry, rpc, lists.reads, lists, service, limiter];
      return ports.length;
    };
    expect(typeof assertions).toBe('function');
  });
});
