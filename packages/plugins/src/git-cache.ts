import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PluginStateError } from './errors';
import type { MarketplaceRow, MarketplaceStore, ReleaseStore } from './ports';
import { initBareRepository } from './release';
import { rebuildRelease } from './release-service';

/** Default of `BASTION_GIT_CACHE_DIR` (21.1). */
export const DEFAULT_GIT_CACHE_DIR = '/var/cache/bastion/git';

export type RepositoryHandle = {
  /** Directory to use as `GIT_PROJECT_ROOT`; the repository is `<root>/repo.git`. */
  root: string;
  gitdir: string;
  seq: number;
  commit: string;
};

const REPO_NAME = 'repo.git';
const MARKER = '.complete';

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Builds release repositories into `BASTION_GIT_CACHE_DIR` on first request (25.5). Layout:
 * `<cache>/<slug>/r<N>/repo.git` holds the whole chain of releases 1..N, so every replica serves the
 * same commits. A new release copies the previous repository and adds one commit.
 */
export class GitRepositoryCache {
  private readonly inflight = new Map<string, Promise<RepositoryHandle>>();

  constructor(
    private readonly deps: {
      cacheDir: string;
      host: string;
      marketplaces: MarketplaceStore;
      releases: ReleaseStore;
    },
  ) {}

  ensure(marketplace: MarketplaceRow, seq: number): Promise<RepositoryHandle> {
    const key = `${marketplace.slug}:${seq}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = this.build(marketplace, seq).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async build(marketplace: MarketplaceRow, seq: number): Promise<RepositoryHandle> {
    const target = await this.deps.releases.get(marketplace.id, seq);
    if (!target) throw new PluginStateError('RELEASE_NOT_FOUND', 'release not found', 404);
    const slugDir = join(this.deps.cacheDir, marketplace.slug);
    const root = join(slugDir, `r${seq}`);
    const handle = (): RepositoryHandle => ({
      root,
      gitdir: join(root, REPO_NAME),
      seq,
      commit: target.gitCommit,
    });
    if (await exists(join(root, MARKER))) return handle();

    await mkdir(slugDir, { recursive: true });
    const tmp = join(slugDir, `.tmp-r${seq}-${randomBytes(6).toString('hex')}`);
    const gitdir = join(tmp, REPO_NAME);
    await mkdir(tmp, { recursive: true });
    try {
      let start = 1;
      let parent: string | undefined;
      const existing = (await readdir(slugDir))
        .map((n) => /^r(\d+)$/.exec(n)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .filter((n) => n < seq)
        .sort((a, b) => b - a);
      for (const k of existing) {
        if (await exists(join(slugDir, `r${k}`, MARKER))) {
          await cp(join(slugDir, `r${k}`, REPO_NAME), gitdir, { recursive: true });
          start = k + 1;
          parent = (await this.deps.releases.get(marketplace.id, k))?.gitCommit;
          break;
        }
      }
      if (start === 1) await initBareRepository(gitdir);
      for (let s = start; s <= seq; s++) {
        const record = s === seq ? target : await this.deps.releases.get(marketplace.id, s);
        if (!record) throw new PluginStateError('RELEASE_NOT_FOUND', `release ${s} not found`, 404);
        const items = await this.deps.marketplaces.loadReleaseItems(marketplace.id, s);
        const built = await rebuildRelease({
          host: this.deps.host,
          marketplace,
          record,
          items,
          parentCommit: parent,
          gitdir,
        });
        parent = built.record.gitCommit;
      }
      await writeFile(join(tmp, MARKER), `${target.gitCommit}\n`);
      // A crashed build can leave an incomplete directory behind; it never has the marker.
      if (!(await exists(join(root, MARKER)))) await rm(root, { recursive: true, force: true });
      try {
        await rename(tmp, root);
      } catch (error) {
        // Another process finished first; its repository is identical (23.2).
        if (!(await exists(join(root, MARKER)))) throw error;
        await rm(tmp, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(tmp, { recursive: true, force: true });
      throw error;
    }
    return handle();
  }
}
