import type { DistributionEvent } from './ports';

export type ClientKind =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'chatgpt'
  | 'git'
  | 'browser'
  | 'other';

/** Best-effort client from the User-Agent (25.9). Claude Code and Codex fetch through the git binary. */
export const classifyClient = (userAgent: string | null | undefined): ClientKind => {
  const ua = userAgent ?? '';
  if (/claude-cli|claude-code/i.test(ua)) return 'claude-code';
  if (/claude[\s-]?desktop|Claude\/\d.*Electron/i.test(ua)) return 'claude-desktop';
  if (/codex/i.test(ua)) return 'codex';
  if (/chatgpt|openai/i.test(ua)) return 'chatgpt';
  if (/^git\//i.test(ua) || /\bgit\//i.test(ua)) return 'git';
  if (/mozilla\//i.test(ua)) return 'browser';
  return 'other';
};

type EventInput = {
  ts: Date;
  principalId: string;
  marketplaceId: string;
  releaseSeq: number | null;
  userAgent: string | null;
};

export const gitFetchEvent = (input: EventInput): DistributionEvent => ({
  ...input,
  channel: 'git',
  action: 'git_fetch',
});

export const manifestFetchEvent = (input: EventInput): DistributionEvent => ({
  ...input,
  channel: 'https',
  action: 'manifest_fetch',
});

export const archiveDownloadEvent = (input: EventInput): DistributionEvent => ({
  ...input,
  channel: 'https',
  action: 'archive_download',
});

export type UsageEvent = {
  ts: Date;
  principalId: string | null;
  releaseSeq: number | null;
  userAgent: string | null;
};

export type ClientUsage = { installs: number; updates: number; fetches: number; users: number };

export type MarketplaceUsage = {
  perClient: Partial<Record<ClientKind, ClientUsage>>;
  totalUsers: number;
  /** Users whose latest fetch was an older release than `latestSeq` (25.9). */
  usersOnOldRelease: number;
};

/**
 * Aggregation for the marketplace usage page (25.9). A user's first fetch with a given client is an
 * install; a later fetch of a newer release by the same user and client is an update.
 */
export const aggregateUsage = (
  events: readonly UsageEvent[],
  options: { latestSeq: number },
): MarketplaceUsage => {
  const perClient: Partial<Record<ClientKind, ClientUsage>> = {};
  const seen = new Map<string, { maxSeq: number }>();
  const latestByUser = new Map<string, { ts: number; seq: number }>();
  for (const event of [...events].sort((a, b) => a.ts.getTime() - b.ts.getTime())) {
    const client = classifyClient(event.userAgent);
    let usage = perClient[client];
    if (!usage) {
      usage = { installs: 0, updates: 0, fetches: 0, users: 0 };
      perClient[client] = usage;
    }
    usage.fetches += 1;
    if (event.principalId === null) continue;
    const key = `${client}\u0000${event.principalId}`;
    const state = seen.get(key);
    if (!state) {
      usage.installs += 1;
      usage.users += 1;
      seen.set(key, { maxSeq: event.releaseSeq ?? 0 });
    } else if (event.releaseSeq !== null && event.releaseSeq > state.maxSeq) {
      usage.updates += 1;
      state.maxSeq = event.releaseSeq;
    }
    if (event.releaseSeq !== null) {
      latestByUser.set(event.principalId, { ts: event.ts.getTime(), seq: event.releaseSeq });
    }
  }
  let old = 0;
  for (const { seq } of latestByUser.values()) if (seq < options.latestSeq) old += 1;
  return { perClient, totalUsers: latestByUser.size, usersOnOldRelease: old };
};
