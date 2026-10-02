import type { PluginFile } from './types';
import type { ItemPolicy, ReleaseItem } from './render';
import type { ReleaseRecord } from './release';

/**
 * Ports (CONTRIBUTING rule 6): `@bastion-mcp/db` and the apps implement these; this package stays
 * unit-testable and imports neither the database nor the secret store.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Content-addressed file bodies (`blobs`, 16.2). */
export interface BlobStore {
  /** Stores the bytes and returns their lowercase hex SHA-256 (idempotent). */
  put(content: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Uint8Array | undefined>;
}

export type StoredFileRow = {
  path: string;
  blobSha256: string;
  mode: 'file' | 'executable';
  classification: 'plain' | 'executable';
};

/** `catalog_files` (16.2): the file list of one catalog version. Published versions are immutable. */
export interface CatalogFileStore {
  list(catalogVersionId: string): Promise<StoredFileRow[]>;
  /** Replaces the rows of a draft version; must reject when the version is published (11.1). */
  replace(catalogVersionId: string, rows: StoredFileRow[]): Promise<void>;
}

export type MirrorTarget = {
  provider: 'github' | 'gitlab';
  /** `owner/name` (GitHub) or the project path (GitLab). */
  repo: string;
  branch: string;
  credentialSecretId: string;
};

export type MirrorStatus = 'idle' | 'ok' | 'retrying' | 'diverged';

export type MirrorState = {
  status: MirrorStatus;
  lastPushedSeq: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type MarketplaceRow = {
  id: string;
  slug: string;
  displayName: string;
  description?: string | undefined;
  ownerName: string;
  desktopInstallation: 'available' | 'auto_install' | 'required';
  promotedRelease: number | null;
  mirror: MirrorTarget | null;
  mirrorStatus: MirrorState | null;
};

export type ResolvedReleaseItem = ReleaseItem & { entryId: string; versionId: string };

export type ReleaseItemRef = { entryId: string; versionId: string; policy: ItemPolicy };

/** `marketplaces` and `marketplace_items` (16.2), plus resolution of item versions to content. */
export interface MarketplaceStore {
  getBySlug(slug: string): Promise<MarketplaceRow | undefined>;
  getById(id: string): Promise<MarketplaceRow | undefined>;
  /** Items now, with follow-current and pinned versions resolved and files loaded, in position order. */
  resolveItems(marketplaceId: string): Promise<ResolvedReleaseItem[]>;
  /** The content of a past release, from the `{entryId, versionId, policy}` rows it recorded. */
  loadReleaseItems(marketplaceId: string, seq: number): Promise<ReleaseItem[]>;
  setPromotedRelease(marketplaceId: string, seq: number): Promise<void>;
  setMirrorStatus(marketplaceId: string, state: MirrorState): Promise<void>;
}

/** `marketplace_releases` (16.2). Releases are immutable: there is no update. */
export interface ReleaseStore {
  get(marketplaceId: string, seq: number): Promise<ReleaseRecord | undefined>;
  latest(marketplaceId: string): Promise<ReleaseRecord | undefined>;
  list(marketplaceId: string): Promise<ReleaseRecord[]>;
  /** Must throw when `(marketplaceId, seq)` exists, so racing replicas cannot both publish. */
  insert(
    marketplaceId: string,
    record: ReleaseRecord,
    refs: ReleaseItemRef[],
    createdBy: string | null,
  ): Promise<void>;
}

export type PluginPrincipal = { id: string; scopes: readonly string[] };

/** Authentication and audience for `/plugins/*` (9.3, 25.4). */
export interface PluginAccess {
  /** Resolves a PAT or OAuth access token; `undefined` when invalid or expired. */
  authenticate(secret: string): Promise<PluginPrincipal | undefined>;
  /** Audience check; `false` makes every channel answer 404 (25.4). */
  canView(principal: PluginPrincipal, marketplace: MarketplaceRow): Promise<boolean>;
}

export type DistributionEvent = {
  ts: Date;
  principalId: string;
  marketplaceId: string;
  releaseSeq: number | null;
  channel: 'git' | 'https' | 'mirror';
  action: 'git_fetch' | 'manifest_fetch' | 'archive_download' | 'mirror_push';
  userAgent: string | null;
};

/** `distribution_events` (16.2, 25.9). */
export interface DistributionEventSink {
  record(event: DistributionEvent): Promise<void>;
}

/** Resolves the token for a mirror target: GitHub App installation token or GitLab project token. */
export interface MirrorCredentialResolver {
  resolve(credentialSecretId: string, target: MirrorTarget): Promise<string>;
}

export type MirrorPushResult = { status: 'pushed' } | { status: 'rejected-non-fast-forward' };

/** Mirror pushes to GitHub (`contents: write`) or GitLab (`write_repository`) (25.5). */
export interface GitProvider {
  /** Head commit of the remote branch, `null` when the branch or repository is empty. */
  getBranchHead(target: MirrorTarget, token: string): Promise<string | null>;
  /**
   * Pushes `commit` to the branch and the `tags` (`release-N`), never forcing. Returns `rejected-non-fast-forward`
   * when the remote refused because the branch diverged; throws on transient failures.
   */
  push(
    target: MirrorTarget,
    token: string,
    input: { gitdir: string; commit: string; tags: string[] },
  ): Promise<MirrorPushResult>;
}

export type { PluginFile };
