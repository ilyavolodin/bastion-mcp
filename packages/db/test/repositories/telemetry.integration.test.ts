import { newId } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { NIL_UUID } from '../../src/config-version';
import { latencyBucketIndex } from '../../src/latency';
import { listPartitions } from '../../src/partitions';
import {
  type CallLogRow,
  chooseTier,
  createCallLogRepository,
  createEgressEventRepository,
  createTeamRepository,
  createUserRepository,
  withPartitionRetry,
} from '../../src/repositories';
import { dbEnabled, useTestDb } from '../helpers/db';

const DAY = 86_400_000;
/** Tomorrow 12:00 UTC: inside the pre-created partitions and far from "now" so rollup windows are synthetic. */
const base = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 12, 0, 0));
})();
const at = (minutes: number, seconds = 0) =>
  new Date(base.getTime() + minutes * 60_000 + seconds * 1000);

const row = (over: Partial<CallLogRow> = {}): CallLogRow => ({
  id: newId(),
  ts: at(0),
  durationMs: 10,
  principalType: 'user',
  principalId: newId(),
  method: 'tools/call',
  outcome: 'ok',
  eraDown: 'modern',
  coldStart: false,
  bytesIn: 1,
  bytesOut: 100,
  ...over,
});

describe('15.5 tier choice', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it.each([
    ['short and recent: minute', new Date(now.getTime() - 3_600_000), now, 'minute'],
    ['a week: hour', new Date(now.getTime() - 7 * DAY), now, 'hour'],
    ['two months: hour', new Date(now.getTime() - 60 * DAY), now, 'hour'],
    ['half a year: day', new Date(now.getTime() - 180 * DAY), now, 'day'],
    [
      'short but old (past minute retention): hour',
      new Date(now.getTime() - 30 * DAY - 3_600_000),
      new Date(now.getTime() - 30 * DAY),
      'hour',
    ],
    [
      'short and very old: day',
      new Date(now.getTime() - 200 * DAY - 3_600_000),
      new Date(now.getTime() - 200 * DAY),
      'day',
    ],
  ])('%s', (_n, from, to, tier) => {
    expect(chooseTier(from, to, now)).toBe(tier);
  });
});

describe.skipIf(!dbEnabled())('15.5 call log, rollups, stats, retention and egress events', () => {
  const h = useTestDb();

  it('15.5 writes batches over the chunk size idempotently and keeps JSON details', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const rows = Array.from({ length: 2300 }, (_, i) =>
      row({ ts: at(300, i % 50), itemName: `bulk${i % 3}` }),
    );
    await repo.insertBatch(rows);
    await repo.insertBatch(rows.slice(0, 100));
    expect(await h.db.prisma.callLog.count({ where: { itemName: { startsWith: 'bulk' } } })).toBe(
      2300,
    );
    const detailed = row({
      ts: at(301),
      guardResults: [{ guard: 'regex' }],
      policyReasons: ['p1'],
      argsPreview: { a: 1 },
      resultPreview: { r: 2 },
      traceId: 't',
      spanId: 's',
      errorCode: 'X',
      jsonrpcCode: -32000,
      clientId: 'c',
      clientName: 'Claude',
      eraUp: 'legacy',
      upstreamName: 'up',
      outcome: 'tool_error',
    });
    await repo.insertBatch([detailed]);
    const got = await repo.get(detailed.id, { ts: detailed.ts });
    expect(got).toMatchObject({
      guardResults: [{ guard: 'regex' }],
      policyReasons: ['p1'],
      argsPreview: { a: 1 },
      resultPreview: { r: 2 },
      outcome: 'tool_error',
      jsonrpcCode: -32000,
    });
    expect((await repo.get(detailed.id))?.id).toBe(detailed.id);
    expect(await repo.get(newId())).toBeNull();
    await repo.insertBatch([]);
    await expect(repo.insertBatch([row({ outcome: 'weird' as never })])).rejects.toThrow();
  });

  it('25.8 call_log.origin defaults to direct and records plugin traffic (migration 0003)', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const direct = row({ ts: at(310) });
    const plugin = row({ ts: at(311), origin: 'plugin' });
    await repo.insertBatch([direct, plugin]);
    expect((await repo.get(direct.id))?.origin).toBe('direct');
    expect((await repo.get(plugin.id))?.origin).toBe('plugin');
    const listed = await repo.list({ from: at(309), to: at(312) });
    expect(listed.items.map((i) => i.origin).sort()).toEqual(['direct', 'plugin']);
    await expect(repo.insertBatch([row({ origin: 'x' as never })])).rejects.toThrow();
  });

  it('15.5 lists calls by user, team, installation, item, outcome and time range with keyset cursors', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const users = createUserRepository(h.db.prisma);
    const teams = createTeamRepository(h.db.prisma);
    const [u1, u2, u3] = await Promise.all(
      ['l1', 'l2', 'l3'].map((n) => users.create({ email: `${n}@acme.com`, displayName: n })),
    );
    const team = await teams.create({ slug: 'loggers', displayName: 'L' });
    await teams.setMembership({ teamId: team.id, userId: u1?.id ?? '', role: 'member' });
    await teams.setMembership({ teamId: team.id, userId: u2?.id ?? '', role: 'member' });
    const inst = newId();
    const entry = newId();
    const b = at(400);
    const mk = (principalId: string, offset: number, over: Partial<CallLogRow> = {}) =>
      row({ principalId, ts: new Date(b.getTime() + offset * 1000), ...over });
    const rows = [
      mk(u1?.id ?? '', 0, {
        installationId: inst,
        itemName: 'pg_query',
        catalogEntryId: entry,
        endpointId: inst,
      }),
      mk(u1?.id ?? '', 1, {
        installationId: inst,
        itemName: 'pg_query',
        outcome: 'denied',
        clientId: 'cursor',
      }),
      mk(u2?.id ?? '', 2, { installationId: inst, itemName: 'pg_list', outcome: 'tool_error' }),
      mk(u3?.id ?? '', 3, { method: 'tools/list' }),
      mk(u3?.id ?? '', 3, { itemName: 'same-ts-1' }),
      mk(u3?.id ?? '', 3, { itemName: 'same-ts-2' }),
    ];
    await repo.insertBatch(rows);
    const range = { from: b, to: new Date(b.getTime() + 60_000) };
    expect((await repo.list({ ...range, principalId: u1?.id })).items).toHaveLength(2);
    expect((await repo.list({ ...range, teamIds: [team.id] })).items).toHaveLength(3);
    expect(
      (await repo.list({ ...range, teamIds: [team.id], principalId: u3?.id })).items,
    ).toHaveLength(0);
    expect(
      (await repo.list({ ...range, teamIds: [team.id], principalId: u1?.id })).items,
    ).toHaveLength(2);
    expect((await repo.list({ ...range, installationId: inst })).items).toHaveLength(3);
    expect((await repo.list({ ...range, catalogEntryId: entry })).items).toHaveLength(1);
    expect((await repo.list({ ...range, endpointId: inst })).items).toHaveLength(1);
    expect((await repo.list({ ...range, itemName: 'pg_query' })).items).toHaveLength(2);
    expect((await repo.list({ ...range, outcome: 'denied' })).items).toHaveLength(1);
    expect((await repo.list({ ...range, outcome: ['denied', 'tool_error'] })).items).toHaveLength(
      2,
    );
    expect((await repo.list({ ...range, clientId: 'cursor' })).items).toHaveLength(1);
    expect((await repo.list({ ...range, method: 'tools/list' })).items).toHaveLength(1);
    expect(
      (await repo.list({ from: new Date(b.getTime() + 2000), to: new Date(b.getTime() + 3000) }))
        .items,
    ).toHaveLength(1);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await repo.list({ ...range, limit: 2, cursor });
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    const first = (await repo.list({ ...range })).items[0];
    expect(first?.ts.getTime()).toBe(b.getTime() + 3000);
    expect(first).not.toHaveProperty('argsPreview');
    await expect(repo.list({ cursor: 'zzz' })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      repo.list({ cursor: Buffer.from('["a","b"]').toString('base64url') }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('15.5 minute rollup: counts, errors, bytes and SQL latency buckets match the TS bucket math; unattributed keys use nil', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const inst = newId();
    const durations = [0, 1, 2, 3, 4, 5, 8, 9, 13, 100, 1_000, 59_999, 60_000, 60_001, 5_000_000];
    const m = at(500);
    await repo.insertBatch(
      durations.map((d, i) =>
        row({
          ts: new Date(m.getTime() + i * 1000),
          installationId: inst,
          itemName: `lat${d}`,
          durationMs: d,
          catalogEntryId: i === 0 ? newId() : null,
        }),
      ),
    );
    await repo.insertBatch([
      row({
        ts: new Date(m.getTime() + 20_000),
        installationId: inst,
        itemName: 'agg',
        durationMs: 7,
        bytesOut: 10,
      }),
      row({
        ts: new Date(m.getTime() + 21_000),
        installationId: inst,
        itemName: 'agg',
        durationMs: 7,
        bytesOut: 20,
      }),
      row({
        ts: new Date(m.getTime() + 22_000),
        installationId: inst,
        itemName: 'agg',
        durationMs: 900,
        bytesOut: 5,
        outcome: 'ok',
      }),
      row({
        ts: new Date(m.getTime() + 23_000),
        installationId: inst,
        itemName: 'agg',
        durationMs: 900,
        outcome: 'blocked',
        bytesOut: 1,
      }),
      row({
        ts: new Date(m.getTime() + 24_000),
        installationId: inst,
        itemName: 'agg',
        durationMs: 5,
        outcome: 'input_required',
        bytesOut: 0,
      }),
      row({
        ts: new Date(m.getTime() + 25_000),
        itemName: null,
        installationId: null,
        durationMs: 3,
        bytesOut: 7,
      }),
    ]);
    const now = new Date(m.getTime() + 5 * 60_000);
    const result = await repo.rollupMinuteJob(now);
    expect(result.tier).toBe('minute');
    expect(result.buckets).toBeGreaterThan(10);
    const stats = await h.db.prisma.callStatsMinute.findMany({ where: { installationId: inst } });
    for (const d of durations) {
      const r = stats.find((s) => s.itemName === `lat${d}`);
      expect(r?.count).toBe(1);
      const hist = r?.latencyBuckets ?? [];
      expect(hist).toHaveLength(24);
      expect(hist[latencyBucketIndex(d)]).toBe(1);
      expect(hist.reduce((a, b) => a + b, 0)).toBe(1);
    }
    const agg = stats.filter((s) => s.itemName === 'agg');
    const ok = agg.find((s) => s.outcome === 'ok');
    expect(ok).toMatchObject({ count: 3, errorCount: 0, bytesOut: 35n });
    expect(ok?.latencyBuckets[latencyBucketIndex(7)]).toBe(2);
    expect(ok?.latencyBuckets[latencyBucketIndex(900)]).toBe(1);
    expect(agg.find((s) => s.outcome === 'blocked')).toMatchObject({ count: 1, errorCount: 1 });
    expect(agg.find((s) => s.outcome === 'input_required')).toMatchObject({ errorCount: 0 });
    const unattributed = await h.db.prisma.callStatsMinute.findFirst({
      where: {
        installationId: NIL_UUID,
        bucket: new Date(Math.floor(m.getTime() / 60_000) * 60_000),
      },
    });
    expect(unattributed).toMatchObject({ itemName: '', count: 1, bytesOut: 7n });
    expect(stats.find((s) => s.itemName === 'lat0')?.catalogEntryId).not.toBeNull();

    // finished minutes only: the current minute is not rolled yet
    const live = new Date(m.getTime() + 6 * 60_000 + 10_000);
    await repo.insertBatch([row({ ts: live, installationId: inst, itemName: 'live' })]);
    await repo.rollupMinuteJob(live);
    expect(await h.db.prisma.callStatsMinute.count({ where: { itemName: 'live' } })).toBe(0);
    await repo.rollupMinuteJob(new Date(live.getTime() + 60_000));
    expect(await h.db.prisma.callStatsMinute.count({ where: { itemName: 'live' } })).toBe(1);

    // idempotent and picks up a late row inside the lookback window
    await repo.rollupMinuteJob(new Date(live.getTime() + 60_000));
    expect(
      (await h.db.prisma.callStatsMinute.findFirstOrThrow({ where: { itemName: 'live' } })).count,
    ).toBe(1);
    await repo.insertBatch([
      row({ ts: new Date(live.getTime() + 5000), installationId: inst, itemName: 'live' }),
    ]);
    await repo.rollupMinuteJob(new Date(live.getTime() + 2 * 60_000));
    expect(
      (await h.db.prisma.callStatsMinute.findFirstOrThrow({ where: { itemName: 'live' } })).count,
    ).toBe(2);
  });

  it('15.5 hour and day rollups merge minutes, error counts and histograms; stats read only rollups', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const inst = newId();
    const entry = newId();
    const h0 = at(600); // some minute in a fresh hour
    const hourStart = new Date(Math.floor(h0.getTime() / 3_600_000) * 3_600_000);
    const t = (min: number, sec = 0) => new Date(hourStart.getTime() + min * 60_000 + sec * 1000);
    await repo.insertBatch([
      row({
        ts: t(1),
        installationId: inst,
        catalogEntryId: entry,
        itemName: 'tool_a',
        durationMs: 5,
        bytesOut: 10,
      }),
      row({
        ts: t(2),
        installationId: inst,
        catalogEntryId: entry,
        itemName: 'tool_a',
        durationMs: 50,
        bytesOut: 20,
      }),
      row({
        ts: t(30),
        installationId: inst,
        catalogEntryId: entry,
        itemName: 'tool_a',
        durationMs: 500,
        bytesOut: 30,
        outcome: 'error',
      }),
      row({
        ts: t(31),
        installationId: inst,
        catalogEntryId: entry,
        itemName: 'tool_b',
        durationMs: 5000,
        bytesOut: 40,
      }),
    ]);
    const nextHour = new Date(hourStart.getTime() + 3_600_000 + 60_000);
    await repo.rollupMinuteJob(nextHour);
    const hourRes = await repo.rollupHourJob(nextHour);
    expect(hourRes.tier).toBe('hour');
    const hourRows = await h.db.prisma.callStatsHour.findMany({ where: { installationId: inst } });
    const a = hourRows.find((r) => r.itemName === 'tool_a' && r.outcome === 'ok');
    expect(a).toMatchObject({
      count: 2,
      bytesOut: 30n,
      errorCount: 0,
      catalogEntryId: entry,
      bucket: hourStart,
    });
    expect(a?.latencyBuckets[latencyBucketIndex(5)]).toBe(1);
    expect(a?.latencyBuckets[latencyBucketIndex(50)]).toBe(1);
    expect(hourRows.find((r) => r.itemName === 'tool_a' && r.outcome === 'error')).toMatchObject({
      errorCount: 1,
    });
    await repo.rollupHourJob(nextHour);
    expect(
      (
        await h.db.prisma.callStatsHour.findMany({
          where: { installationId: inst, itemName: 'tool_a', outcome: 'ok' },
        })
      )[0]?.count,
    ).toBe(2);

    const dayStart = new Date(Math.floor(hourStart.getTime() / DAY) * DAY);
    const nextDay = new Date(dayStart.getTime() + DAY + 3_600_000);
    await repo.rollupMinuteJob(nextDay);
    await repo.rollupHourJob(nextDay);
    const dayRes = await repo.rollupDayJob(nextDay);
    expect(dayRes.tier).toBe('day');
    const dayRow = await h.db.prisma.callStatsDay.findFirst({
      where: { installationId: inst, itemName: 'tool_a', outcome: 'ok' },
    });
    expect(dayRow).toMatchObject({ count: 2, bucket: dayStart });
    const rolled = await repo.rollupAll(new Date(nextDay.getTime() + 60_000));
    expect(rolled.map((r) => r.tier)).toEqual(['minute', 'hour', 'day']);

    // stats from rollups: totals, by item, by time, by outcome, and percentiles from merged buckets
    const range = {
      from: hourStart,
      to: new Date(hourStart.getTime() + 3_600_000),
      installationId: inst,
      now: hourStart,
    };
    const total = await repo.stats({ ...range, tier: 'hour' });
    expect(total.rows).toHaveLength(1);
    expect(total.rows[0]).toMatchObject({ count: 4, errorCount: 1, bytesOut: 100 });
    expect(total.rows[0]?.p50).toBe(55);
    expect(total.rows[0]?.p99).toBe(8118);
    const byItem = await repo.stats({ ...range, tier: 'minute', groupBy: ['item'] });
    expect(byItem.rows.map((r) => [r.itemName, r.count])).toEqual([
      ['tool_a', 3],
      ['tool_b', 1],
    ]);
    const byOutcome = await repo.stats({ ...range, groupBy: ['outcome'] });
    expect(byOutcome.tier).toBe('minute');
    expect(byOutcome.rows.map((r) => [r.outcome, r.count])).toEqual([
      ['error', 1],
      ['ok', 3],
    ]);
    const byTime = await repo.stats({ ...range, tier: 'minute', groupBy: ['time'] });
    expect(byTime.rows.map((r) => r.bucket?.getTime())).toEqual([
      t(1).getTime(),
      t(2).getTime(),
      t(30).getTime(),
      t(31).getTime(),
    ]);
    const byInst = await repo.stats({
      ...range,
      tier: 'hour',
      groupBy: ['installation', 'catalogEntry'],
    });
    expect(byInst.rows[0]).toMatchObject({ installationId: inst, catalogEntryId: entry, count: 4 });
    const filtered = await repo.stats({
      ...range,
      tier: 'day',
      from: dayStart,
      to: new Date(dayStart.getTime() + DAY),
      catalogEntryId: entry,
      itemName: 'tool_a',
      outcome: 'ok',
    });
    expect(filtered.rows[0]).toMatchObject({ count: 2 });
    const none = await repo.stats({
      from: hourStart,
      to: new Date(hourStart.getTime() + 3_600_000),
      installationId: newId(),
      tier: 'hour',
    });
    expect(none.rows).toEqual([]);
    const nilGroups = await repo.stats({
      from: hourStart,
      to: new Date(hourStart.getTime() + 3_600_000),
      tier: 'minute',
      groupBy: ['installation', 'catalogEntry'],
      now: hourStart,
    });
    expect(nilGroups.rows.length).toBeGreaterThan(0);
    await expect(repo.stats({ from: hourStart, to: hourStart })).rejects.toMatchObject({
      httpStatus: 422,
    });
  });

  it('15.5 retention drops old stats rows and partitions past logs.retentionDays', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    const now = new Date();
    const old = (days: number) => new Date(now.getTime() - days * DAY);
    const mkStats = (bucket: Date) => ({
      bucket,
      installationId: newId(),
      itemName: 'ret',
      outcome: 'ok',
      count: 1,
      bytesOut: 1n,
      latencyBuckets: new Array(24).fill(0),
    });
    await h.db.prisma.callStatsMinute.createMany({ data: [mkStats(old(8)), mkStats(old(1))] });
    await h.db.prisma.callStatsHour.createMany({ data: [mkStats(old(91)), mkStats(old(10))] });
    await h.db.prisma.callStatsDay.createMany({ data: [mkStats(old(731)), mkStats(old(100))] });
    await repo.ensurePartitionsAhead(9);
    const before = (await listPartitions(h.db.prisma, 'call_log')).length;
    const result = await repo.applyRetention(new Date(now.getTime() + 5 * DAY), {
      logsRetentionDays: 2,
    });
    expect(result.statsRows).toMatchObject({
      minute: expect.any(Number),
      hour: expect.any(Number),
      day: expect.any(Number),
    });
    expect(result.partitions.call_log).toBeGreaterThan(0);
    expect((await listPartitions(h.db.prisma, 'call_log')).length).toBe(
      before - result.partitions.call_log,
    );
    expect(await h.db.prisma.callStatsMinute.count({ where: { itemName: 'ret' } })).toBe(1);
    expect(await h.db.prisma.callStatsHour.count({ where: { itemName: 'ret' } })).toBe(1);
    expect(await h.db.prisma.callStatsDay.count({ where: { itemName: 'ret' } })).toBe(1);
  });

  it('15.5 inserting into a missing partition creates it and retries once', async () => {
    const repo = createCallLogRepository(h.db.prisma);
    // earlier retention test dropped partitions up to today+3; ask for a day in that gap relative to ensure+7
    const ts = new Date(Date.now() + 1000);
    await repo.insertBatch([row({ ts, itemName: 'after-drop' })]);
    expect(await h.db.prisma.callLog.count({ where: { itemName: 'after-drop' } })).toBe(1);
    await expect(
      withPartitionRetry(h.db.prisma, 'call_log', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('8.8 egress events are recorded and listed per instance or installation, denials filterable', async () => {
    const repo = createEgressEventRepository(h.db.prisma);
    const user = await createUserRepository(h.db.prisma).create({
      email: 'egress@acme.com',
      displayName: 'E',
    });
    const installId = newId();
    await h.db.prisma.installation.create({
      data: {
        id: installId,
        ownerType: 'user',
        ownerId: user.id,
        slug: 'eg',
        toolPrefix: 'eg',
        displayName: 'EG',
        origin: 'manual',
        personalSpec: { type: 'remote' },
      },
    });
    const instanceId = newId();
    await h.db.prisma.instance.create({
      data: { id: instanceId, installationId: installId, kind: 'sandbox', state: 'running' },
    });
    const ts = Date.now();
    await repo.record({
      instanceId,
      protocol: 'https',
      host: 'api.example',
      port: 443,
      resolvedIp: '203.0.113.7',
      decision: 'allow',
      bytesUp: 10.7,
      bytesDown: 2000,
      durationMs: 12.2,
      ts,
    });
    await repo.record({
      instanceId,
      protocol: 'tcp',
      host: 'evil.example',
      port: 22,
      resolvedIp: null,
      decision: 'deny',
      reason: 'blocked_address',
      bytesUp: 0,
      bytesDown: -5,
      durationMs: 1,
      ts: ts + 1000,
    });
    const other = newId();
    await repo.record({
      instanceId: other,
      protocol: 'https',
      host: 'x',
      port: 1,
      resolvedIp: null,
      decision: 'allow',
      bytesUp: 0,
      bytesDown: 0,
      durationMs: 0,
      ts: ts + 2000,
    });
    const all = await repo.list({ installationId: installId });
    expect(all.items.map((e) => e.host)).toEqual(['evil.example', 'api.example']);
    expect(all.items[1]).toMatchObject({
      ip: '203.0.113.7',
      bytesUp: 10,
      durationMs: 12,
      protocol: 'https',
    });
    expect(all.items[0]).toMatchObject({ reason: 'blocked_address', bytesDown: 0, ip: null });
    expect((await repo.list({ instanceId: other })).items).toHaveLength(1);
    expect((await repo.list({ installationId: installId, instanceId: other })).items).toHaveLength(
      0,
    );
    expect(
      (await repo.list({ installationId: installId, decision: 'deny' })).items.map((e) => e.host),
    ).toEqual(['evil.example']);
    expect(
      (
        await repo.list({
          installationId: installId,
          from: new Date(ts + 500),
          to: new Date(ts + 1500),
        })
      ).items,
    ).toHaveLength(1);
    const p1 = await repo.list({ installationId: installId, limit: 1 });
    expect(
      (
        await repo.list({ installationId: installId, limit: 1, cursor: p1.nextCursor ?? undefined })
      ).items.map((e) => e.host),
    ).toEqual(['api.example']);
    await expect(
      repo.record({
        instanceId,
        protocol: 'x',
        host: 'h',
        port: 1,
        resolvedIp: null,
        decision: 'maybe' as never,
        bytesUp: 0,
        bytesDown: 0,
        durationMs: 0,
        ts,
      }),
    ).rejects.toThrow();
  });
});
