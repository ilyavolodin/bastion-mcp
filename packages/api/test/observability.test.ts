import { afterEach, describe, expect, it } from 'vitest';
import { csvCell } from '../src/services/audit';
import { buildTestApi, type TestApi } from './helpers/harness';
import { W } from './helpers/world';

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const ids = (body: unknown): string[] => (rec(body).items as { id: string }[]).map((i) => i.id);

describe('15.5 calls', () => {
  it('15.5 admins and auditors read the whole call log with filters', async () => {
    api = await buildTestApi();
    expect(ids((await api.call('admin', 'GET', '/calls')).body)).toHaveLength(4);
    expect(
      ids((await api.call('auditor', 'GET', '/calls', { query: { outcome: 'denied' } })).body),
    ).toEqual(['call-2']);
    const filtered = await api.call('admin', 'GET', '/calls', {
      query: {
        installation: 'inst-1',
        item: 'tool_a',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(ids(filtered.body)).toEqual(['call-1', 'call-3']);
  });

  it('15.5 members and managers need a scope: the org-wide log is denied', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'GET', '/calls')).status).toBe(403);
    expect((await api.call('managerOwn', 'GET', '/calls')).status).toBe(403);
    expect(
      (await api.call('managerOwn', 'GET', '/calls', { query: { team: W.teamA, user: W.memberA } }))
        .status,
    ).toBe(403);
  });

  it('15.5 a manager reads their team log, a member reads their own calls', async () => {
    api = await buildTestApi();
    const team = await api.call('managerOwn', 'GET', '/calls', { query: { team: W.teamA } });
    expect(ids(team.body)).toEqual(['call-1', 'call-3']);
    expect(
      (await api.call('managerOther', 'GET', '/calls', { query: { team: W.teamA } })).status,
    ).toBe(403);
    const own = await api.call('member', 'GET', '/calls', { query: { user: W.memberA } });
    expect(ids(own.body)).toEqual(['call-1']);
    expect((await api.call('member', 'GET', '/calls', { query: { user: W.memberB } })).status).toBe(
      403,
    );
    expect((await api.call('member', 'GET', '/calls', { query: { user: 'ghost' } })).status).toBe(
      403,
    );
  });

  it('10.1 service accounts have no call-log view, not even their own calls', async () => {
    api = await buildTestApi();
    expect((await api.call('service', 'GET', '/calls', { query: { user: W.svc } })).status).toBe(
      403,
    );
    expect((await api.call('service', 'GET', '/calls/call-3')).status).toBe(403);
  });

  it('15.5 rejects an invalid outcome or time range', async () => {
    api = await buildTestApi();
    expect((await api.call('admin', 'GET', '/calls', { query: { outcome: 'bogus' } })).status).toBe(
      400,
    );
    expect(
      (await api.call('admin', 'GET', '/calls', { query: { from: 'yesterday' } })).status,
    ).toBe(400);
  });

  it('15.5 a call is authorized on its owner and unknown ids do not leak existence', async () => {
    api = await buildTestApi();
    expect((await api.call('member', 'GET', '/calls/call-1')).status).toBe(200);
    expect((await api.call('member', 'GET', '/calls/call-2')).status).toBe(403);
    expect((await api.call('member', 'GET', '/calls/nope')).status).toBe(403);
    expect((await api.call('admin', 'GET', '/calls/nope')).status).toBe(404);
    expect((await api.call('managerOwn', 'GET', '/calls/call-1')).status).toBe(200);
    expect((await api.call('managerOther', 'GET', '/calls/call-1')).status).toBe(403);
    expect((await api.call('admin', 'GET', '/calls/call-anon')).status).toBe(200);
    expect((await api.call('member', 'GET', '/calls/call-anon')).status).toBe(403);
  });
});

describe('15.5 statistics and findings', () => {
  it('15.5 serves rollup series for admins and auditors', async () => {
    api = await buildTestApi();
    for (const url of ['/stats/calls', '/stats/latency', '/stats/guards', '/stats/sandboxes']) {
      const res = await api.call('auditor', 'GET', url, {
        query: { bucket: 'hour', groupBy: 'outcome' },
      });
      expect(res.status).toBe(200);
      expect(rec((rec(res.body).buckets as unknown[])[0])).toMatchObject({ group: 'a' });
      expect((await api.call('member', 'GET', url)).status).toBe(403);
    }
  });

  it('15.5 managers read call stats for their own team only', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('managerOwn', 'GET', '/stats/calls', { query: { team: W.teamA } })).status,
    ).toBe(200);
    expect(
      (await api.call('managerOwn', 'GET', '/stats/calls', { query: { team: W.teamB } })).status,
    ).toBe(403);
    expect(
      (await api.call('managerOwn', 'GET', '/stats/latency', { query: { team: W.teamA } })).status,
    ).toBe(403);
  });

  it('15.5 rejects a bad bucket or groupBy', async () => {
    api = await buildTestApi();
    expect(
      (await api.call('admin', 'GET', '/stats/calls', { query: { bucket: 'year' } })).status,
    ).toBe(400);
    expect(
      (await api.call('admin', 'GET', '/stats/calls', { query: { groupBy: 'a;b' } })).status,
    ).toBe(400);
  });

  it('15.5 lists security findings for admins and auditors only', async () => {
    api = await buildTestApi();
    expect(ids((await api.call('admin', 'GET', '/security/findings')).body)).toEqual(['f1']);
    expect((await api.call('managerOwn', 'GET', '/security/findings')).status).toBe(403);
  });
});

describe('15.6 audit', () => {
  it('15.6 lists audit events for admins and auditors, team-scoped for managers', async () => {
    api = await buildTestApi();
    expect(ids((await api.call('auditor', 'GET', '/audit')).body)).toEqual(['a1', 'a2']);
    expect((await api.call('managerOwn', 'GET', '/audit')).status).toBe(403);
    expect(
      ids((await api.call('managerOwn', 'GET', '/audit', { query: { team: W.teamA } })).body),
    ).toEqual(['a1']);
    expect(
      (await api.call('managerOwn', 'GET', '/audit', { query: { team: W.teamB } })).status,
    ).toBe(403);
    expect((await api.call('member', 'GET', '/audit', { query: { team: W.teamA } })).status).toBe(
      403,
    );
  });

  it('15.6 exports CSV as an attachment with formula injection neutralized', async () => {
    api = await buildTestApi();
    const res = await api.call('auditor', 'GET', '/audit/export', { query: { format: 'csv' } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const lines = res.raw.trim().split('\r\n');
    expect(lines[0]).toBe(
      'seq,id,ts,actorType,actorId,action,targetType,targetId,ip,requestId,diff',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('team.create');
    expect(lines[1]).toContain(",'=cmd|calc,");
    expect(lines[1]).not.toContain(',=cmd');
  });

  it('15.6 exports JSON and defaults to CSV', async () => {
    api = await buildTestApi();
    const json = await api.call('admin', 'GET', '/audit/export', { query: { format: 'json' } });
    expect(json.status).toBe(200);
    expect((json.body as unknown[]).length).toBe(2);
    const empty = await api.call('admin', 'GET', '/audit/export');
    expect(String(empty.headers['content-type'])).toContain('text/csv');
    expect(
      (await api.call('admin', 'GET', '/audit/export', { query: { format: 'xml' } })).status,
    ).toBe(400);
    expect((await api.call('managerOwn', 'GET', '/audit/export')).status).toBe(403);
  });

  it('15.6 verifies the hash chain', async () => {
    api = await buildTestApi();
    const res = await api.call('auditor', 'GET', '/audit/verify');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, checked: 2 });
    expect((await api.call('member', 'GET', '/audit/verify')).status).toBe(403);
  });

  it('15.6 reports the sequence where the chain breaks', async () => {
    const probe = await buildTestApi();
    const observability = probe.deps.observability;
    await probe.close();
    api = await buildTestApi({
      overrides: {
        observability: {
          ...observability,
          audit: {
            ...observability.audit,
            verify: async () => ({ ok: false as const, checked: 1, brokenAtSeq: '2' }),
          },
        },
      },
    });
    const res = await api.call('admin', 'GET', '/audit/verify');
    expect(res.body).toEqual({ ok: false, checked: 1, brokenAtSeq: '2' });
  });

  it('15.6 csvCell escapes quotes, commas, newlines and formula prefixes', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    for (const prefix of ['=', '+', '-', '@'])
      expect(csvCell(`${prefix}1+1`)).toBe(`'${prefix}1+1`);
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(7)).toBe('7');
  });
});
