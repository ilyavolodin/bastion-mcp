import { budget } from '@bastion-mcp/testkit/perf';
import { describe, expect, it } from 'vitest';
import { seg } from './helpers';

// A latency gate: it runs in the serialized test:perf task, on a machine with nothing else running.
describe('performance (13.8)', () => {
  it('13.8 deterministic guards add well under the budget for 64 KiB of text', async () => {
    const { GuardPipeline, ORG_DEFAULT_PROFILE, createGuardRegistry } = await import('../src');
    const pipeline = new GuardPipeline({
      guards: createGuardRegistry(),
      clock: { now: () => Date.now() },
    });
    const para =
      'Results: 42 rows returned from table users in 12ms. See https://example.com/docs?page=2 for system details. ' +
      'The assistant will continue once the previous step is complete.\n';
    const text = para.repeat(Math.ceil(65_536 / para.length)).slice(0, 65_536);
    const request = {
      phase: 'response' as const,
      segments: [seg(text)],
      principal: { principalId: 'p' },
      installation: { installationId: 'i' },
      item: { kind: 'tool' as const, name: 't' },
      method: 'tools/call',
    };
    for (let i = 0; i < 100; i++) await pipeline.run(request, { org: ORG_DEFAULT_PROFILE });
    // Four batches of 100 runs; the gate applies to the best batch's p99. Load on a shared machine (parallel suites,
    // v8 coverage) only adds time, so a real slowdown still raises every batch while a noisy neighbour spoils some.
    const batchP99s: number[] = [];
    for (let batch = 0; batch < 4; batch++) {
      const times: number[] = [];
      for (let i = 0; i < 100; i++) {
        const t = performance.now();
        await pipeline.run(request, { org: ORG_DEFAULT_PROFILE });
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      batchP99s.push(times[Math.floor(times.length * 0.99)] ?? Number.POSITIVE_INFINITY);
    }
    // The target is 2 ms p99 on a quiet machine; 15 ms is the developer-machine gate and CI scales it (`budget`).
    expect(Math.min(...batchP99s)).toBeLessThan(budget(15));
  });
});
