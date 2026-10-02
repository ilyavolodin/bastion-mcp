import type { Page } from './store';

export type CallFilter = {
  userId?: string | undefined;
  teamId?: string | undefined;
  installationId?: string | undefined;
  item?: string | undefined;
  outcome?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

export type CallRecord = { id: string; ts: string; userId: string | null } & Record<
  string,
  unknown
>;

export type StatsQuery = {
  groupBy?: string | undefined;
  bucket?: 'minute' | 'hour' | 'day' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  teamId?: string | undefined;
};

export type StatsSeries = {
  buckets: Array<{ ts: string; group: string | null; values: Record<string, number> }>;
};

export type FindingRecord = { id: string } & Record<string, unknown>;

export interface CallReader {
  list(filter: CallFilter): Promise<Page<CallRecord>>;
  get(id: string): Promise<CallRecord | null>;
  callStats(query: StatsQuery): Promise<StatsSeries>;
  latency(query: StatsQuery): Promise<StatsSeries>;
  guardStats(query: StatsQuery): Promise<StatsSeries>;
  sandboxStats(query: StatsQuery): Promise<StatsSeries>;
  findings(filter: {
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<FindingRecord>>;
}

export type AuditEventView = {
  seq: string;
  id: string;
  ts: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  requestId: string | null;
};

export type AuditVerifyResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAtSeq: string };

export interface AuditReader {
  list(filter: {
    teamId?: string | undefined;
    actorId?: string | undefined;
    action?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<AuditEventView>>;
  /** Streams every event matching the filter, for export. */
  all(filter: {
    from?: string | undefined;
    to?: string | undefined;
  }): AsyncIterable<AuditEventView>;
  verify(): Promise<AuditVerifyResult>;
}
