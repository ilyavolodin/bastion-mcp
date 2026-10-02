import type { ApiDeps, AuditEventView, CallRecord } from '../../../src/ports';
import type { FakeCtx } from '../harness';
import { W } from '../world';

/** A call-log row as `GET /calls` returns it: every column of `call_log` (15.5). */
const call = (row: Partial<CallRecord> & Pick<CallRecord, 'id' | 'ts' | 'userId'>): CallRecord => ({
  durationMs: 12,
  principalType: 'user',
  principalId: row.userId ?? '00000000-0000-0000-0000-000000000000',
  clientId: null,
  clientName: null,
  endpointId: null,
  installationId: null,
  catalogEntryId: null,
  catalogVersionId: null,
  method: 'tools/call',
  itemName: null,
  upstreamName: null,
  outcome: 'ok',
  errorCode: null,
  jsonrpcCode: null,
  eraDown: 'modern',
  eraUp: null,
  coldStart: false,
  bytesIn: 0,
  bytesOut: 0,
  guardResults: null,
  policyReasons: null,
  argsPreview: null,
  resultPreview: null,
  traceId: null,
  spanId: null,
  origin: 'direct',
  ...row,
});

export const CALLS: CallRecord[] = [
  call({
    id: 'call-1',
    ts: '2026-05-01T10:00:00.000Z',
    userId: W.memberA,
    teamId: W.teamA,
    outcome: 'ok',
    installationId: 'inst-1',
    item: 'tool_a',
  }),
  call({
    id: 'call-2',
    ts: '2026-05-01T11:00:00.000Z',
    userId: W.memberB,
    teamId: W.teamB,
    outcome: 'denied',
    installationId: 'inst-2',
    item: 'tool_b',
  }),
  call({
    id: 'call-3',
    ts: '2026-05-01T12:00:00.000Z',
    userId: W.svc,
    teamId: W.teamA,
    outcome: 'ok',
    installationId: 'inst-1',
    item: 'tool_a',
  }),
  call({
    id: 'call-anon',
    ts: '2026-05-01T13:00:00.000Z',
    userId: null,
    outcome: 'error',
  }),
];

export const AUDIT: AuditEventView[] = [
  {
    seq: '1',
    id: 'a1',
    ts: '2026-05-01T10:00:00.000Z',
    actorType: 'user',
    actorId: W.admin,
    action: 'team.create',
    targetType: 'team',
    targetId: W.teamA,
    diff: { note: '=HYPERLINK("x")' },
    ip: '10.0.0.1',
    requestId: '=cmd|calc',
  },
  {
    seq: '2',
    id: 'a2',
    ts: '2026-05-01T11:00:00.000Z',
    actorType: 'user',
    actorId: W.managerB,
    action: 'team.member.set',
    targetType: 'team',
    targetId: W.teamB,
    diff: null,
    ip: null,
    requestId: null,
  },
];

const series = { buckets: [{ ts: '2026-05-01T10:00:00.000Z', group: 'a', values: { calls: 3 } }] };

export const fakeObservabilityDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  observability: {
    calls: {
      list: async (filter) => {
        const items = CALLS.filter(
          (c) =>
            (!filter.userId || c.userId === filter.userId) &&
            (!filter.teamId || c.teamId === filter.teamId) &&
            (!filter.installationId || c.installationId === filter.installationId) &&
            (!filter.item || c.item === filter.item) &&
            (!filter.outcome || c.outcome === filter.outcome),
        );
        return { items: items.slice(0, filter.limit), nextCursor: null };
      },
      get: async (id) => CALLS.find((c) => c.id === id) ?? null,
      callStats: async () => series,
      latency: async () => series,
      guardStats: async () => series,
      sandboxStats: async () => series,
      findings: async () => ({
        items: [
          {
            id: 'f1',
            ts: '2026-05-01T10:00:00.000Z',
            kind: 'guard_block',
            subject: null,
            detail: null,
          },
        ],
        nextCursor: null,
      }),
    },
    audit: {
      list: async (filter) => ({
        items: AUDIT.filter((e) => !filter.teamId || e.targetId === filter.teamId),
        nextCursor: null,
      }),
      all: async function* () {
        for (const e of AUDIT) yield e;
      },
      verify: async () => ({ ok: true as const, checked: AUDIT.length }),
    },
  },
});
