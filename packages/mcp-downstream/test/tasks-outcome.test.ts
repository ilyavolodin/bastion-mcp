/** 6.8 15.3 call-log row, `bastion.calls` and the metric-failure warning of the task operations. */
import { wrapTaskId } from '@bastion-mcp/mcp-upstream';
import type { BastionMetrics } from '@bastion-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/ports';
import { buildEndpoint, installation, items, opContext } from './helpers/fixtures';
import { keyring, makeOps } from './helpers/ops';

type Point = { value: number; attrs: Record<string, unknown> | undefined };

const setup = async (options: { failMetric?: boolean } = {}) => {
  const inst = installation('github', { catalogSlug: 'github' });
  const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
  const points: Point[] = [];
  const metrics = {
    calls: {
      add: (value: number, attrs?: Record<string, unknown>) => {
        if (options.failMetric) throw new Error('boom');
        points.push({ value, attrs });
      },
    },
  } as unknown as BastionMetrics;
  const ops = makeOps({ metrics });
  const warnings: { message: string; meta: unknown }[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
    warn: (message: string, meta?: unknown) => void warnings.push({ message, meta }),
  } as unknown as Logger;
  Object.assign(ops.deps, { logger });
  const ctx = opContext(resolved);
  const id = wrapTaskId(keyring, {
    principalId: ctx.principal.id,
    installationId: inst.id,
    upstreamTaskId: 'up-1',
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  const respond = (status: string) => {
    ops.upstream.taskScript = () => ({ kind: 'complete', result: { taskId: id, status } });
  };
  return { ops, ctx, id, inst, points, warnings, respond };
};

describe('6.8 15.3 task operations record one outcome', () => {
  it('6.8 a non-terminal tasks/get writes no call-log row and records no bastion.calls point', async () => {
    const { ops, ctx, id, points, respond } = await setup();
    respond('working');
    await ops.run('tasks/get', { taskId: id }, ctx);
    expect(ops.rows).toHaveLength(0);
    expect(points).toHaveLength(0);
  });

  it('6.8 a terminal tasks/get writes one row with the final status, the item name and the metric', async () => {
    const { ops, ctx, id, inst, points, respond } = await setup();
    respond('completed');
    await ops.run('tasks/get', { taskId: id }, ctx);
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({
      method: 'tasks/get',
      outcome: 'ok',
      installationId: inst.id,
      catalogEntryId: inst.catalogEntryId,
      catalogVersionId: inst.catalogVersionId,
      itemName: id.slice(0, 12),
      resultPreview: { taskStatus: 'completed' },
    });
    expect(points).toEqual([
      {
        value: 1,
        attrs: expect.objectContaining({ outcome: 'ok', 'bastion.catalog.entry': 'github' }),
      },
    ]);
  });

  it('6.8 a failed task is an error row', async () => {
    const { ops, ctx, id, points, respond } = await setup();
    respond('failed');
    await ops.run('tasks/get', { taskId: id }, ctx);
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({ outcome: 'error' });
    expect(points[0]?.attrs).toMatchObject({ outcome: 'error' });
  });

  it('6.8 tasks/update and tasks/cancel log a row even when the task is not terminal', async () => {
    const { ops, ctx, id, points, respond } = await setup();
    respond('working');
    await ops.run('tasks/update', { taskId: id }, ctx);
    await ops.run('tasks/cancel', { taskId: id }, ctx);
    expect(ops.rows.map((r) => r.method)).toEqual(['tasks/update', 'tasks/cancel']);
    expect(points).toHaveLength(2);
  });

  it('6.8 an upstream failure is rethrown and logged as one error row', async () => {
    const { ops, ctx, id, points } = await setup();
    ops.upstream.taskScript = () => {
      throw new Error('upstream down');
    };
    await expect(ops.run('tasks/cancel', { taskId: id }, ctx)).rejects.toBeDefined();
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({ method: 'tasks/cancel', outcome: 'error' });
    expect(points[0]?.attrs).toMatchObject({ outcome: 'error' });
  });

  it('6.8 a missing, forged or unserved taskId throws before any row exists', async () => {
    const { ops, ctx, points } = await setup();
    await expect(ops.run('tasks/get', {}, ctx)).rejects.toMatchObject({ mcpCode: -32602 });
    await expect(ops.run('tasks/get', { taskId: 'btk1.forged' }, ctx)).rejects.toMatchObject({
      mcpCode: -32602,
    });
    expect(ops.rows).toHaveLength(0);
    expect(points).toHaveLength(0);
  });

  it('15.3 a failing metric is warned about with the method and the row is still written', async () => {
    const { ops, ctx, id, warnings, respond } = await setup({ failMetric: true });
    respond('completed');
    await ops.run('tasks/get', { taskId: id }, ctx);
    expect(warnings.filter((w) => JSON.stringify(w.meta).includes('method'))).toEqual([
      {
        message: 'metric could not be recorded',
        meta: { method: 'tasks/get', error: 'Error: boom' },
      },
    ]);
    expect(ops.rows).toHaveLength(1);
  });
});
