import type { GitRepositoryCache } from './git-cache';
import type {
  Clock,
  GitProvider,
  MarketplaceStore,
  MirrorCredentialResolver,
  MirrorState,
  ReleaseStore,
} from './ports';
import { systemClock } from './ports';
import { PluginStateError } from './errors';

/** Retry backoff of failed mirror pushes (25.5), in minutes; the last value repeats. */
export const MIRROR_BACKOFF_MINUTES = [1, 5, 15, 60] as const;

export const backoffMs = (attempts: number): number => {
  const minutes =
    MIRROR_BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), MIRROR_BACKOFF_MINUTES.length) - 1] ?? 60;
  return minutes * 60_000;
};

export const idleMirrorState = (now: Date): MirrorState => ({
  status: 'idle',
  lastPushedSeq: null,
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  updatedAt: now.toISOString(),
});

/** Whether the scheduler should attempt a push now (never while `diverged`). */
export const isMirrorPushDue = (state: MirrorState, now: Date): boolean => {
  if (state.status === 'diverged') return false;
  if (state.status !== 'retrying' || state.nextAttemptAt === null) return true;
  return new Date(state.nextAttemptAt).getTime() <= now.getTime();
};

export type MirrorPusherDeps = {
  marketplaces: MarketplaceStore;
  releases: ReleaseStore;
  repositories: Pick<GitRepositoryCache, 'ensure'>;
  provider: GitProvider;
  credentials: MirrorCredentialResolver;
  clock?: Clock;
};

/**
 * Pushes release commits and tags to the mirror as fast-forwards (25.5). When the remote branch has
 * diverged the mirror is marked `diverged` and pushing stops until an admin resets it: Bastion never
 * force-pushes. Failures retry with backoff 1, 5, 15, 60 minutes.
 */
export class MirrorPusher {
  constructor(private readonly deps: MirrorPusherDeps) {}

  private now(): Date {
    return (this.deps.clock ?? systemClock).now();
  }

  /** Pushes the latest release. `force: true` ignores the backoff (manual push), never `diverged`. */
  async push(marketplaceId: string, options: { force?: boolean } = {}): Promise<MirrorState> {
    const marketplace = await this.deps.marketplaces.getById(marketplaceId);
    if (!marketplace) throw new PluginStateError('MARKETPLACE_NOT_FOUND', 'marketplace not found', 404);
    const target = marketplace.mirror;
    if (!target) throw new PluginStateError('MIRROR_NOT_CONFIGURED', 'no mirror target', 409);
    const now = this.now();
    const state = marketplace.mirrorStatus ?? idleMirrorState(now);
    if (state.status === 'diverged') return state;
    if (!options.force && !isMirrorPushDue(state, now)) return state;
    const latest = await this.deps.releases.latest(marketplaceId);
    if (!latest) return state;

    const save = async (next: Omit<MirrorState, 'updatedAt'>): Promise<MirrorState> => {
      const saved = { ...next, updatedAt: now.toISOString() };
      await this.deps.marketplaces.setMirrorStatus(marketplaceId, saved);
      return saved;
    };
    const diverged = (): Promise<MirrorState> =>
      save({
        status: 'diverged',
        lastPushedSeq: state.lastPushedSeq,
        attempts: 0,
        nextAttemptAt: null,
        lastError: 'the remote branch has diverged from the release history',
      });

    try {
      const token = await this.deps.credentials.resolve(target.credentialSecretId, target);
      const head = await this.deps.provider.getBranchHead(target, token);
      const releases = (await this.deps.releases.list(marketplaceId))
        .filter((r) => r.seq <= latest.seq)
        .sort((a, b) => a.seq - b.seq);
      let pushedSeq = 0;
      if (head !== null) {
        const known = releases.find((r) => r.gitCommit === head);
        if (!known) return await diverged();
        pushedSeq = known.seq;
      }
      if (pushedSeq < latest.seq) {
        const repo = await this.deps.repositories.ensure(marketplace, latest.seq);
        const result = await this.deps.provider.push(target, token, {
          gitdir: repo.gitdir,
          commit: latest.gitCommit,
          tags: releases.filter((r) => r.seq > pushedSeq).map((r) => `release-${r.seq}`),
        });
        if (result.status === 'rejected-non-fast-forward') return await diverged();
      }
      return await save({
        status: 'ok',
        lastPushedSeq: latest.seq,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      });
    } catch (error) {
      const attempts = state.attempts + 1;
      return save({
        status: 'retrying',
        lastPushedSeq: state.lastPushedSeq,
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)).toISOString(),
        lastError: error instanceof Error ? error.message.slice(0, 500) : 'push failed',
      });
    }
  }

  /** An admin reset after a divergence (the admin has fixed or replaced the remote). */
  async reset(marketplaceId: string): Promise<MirrorState> {
    const state = idleMirrorState(this.now());
    await this.deps.marketplaces.setMirrorStatus(marketplaceId, state);
    return state;
  }
}
