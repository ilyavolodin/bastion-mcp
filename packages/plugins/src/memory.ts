import { sha256Hex } from '@bastion-mcp/core';
import { PluginStateError } from './errors';
import type {
  BlobStore,
  CatalogFileStore,
  DistributionEvent,
  DistributionEventSink,
  MarketplaceRow,
  MarketplaceStore,
  MirrorState,
  PluginAccess,
  PluginPrincipal,
  ReleaseItemRef,
  ReleaseStore,
  ResolvedReleaseItem,
  StoredFileRow,
} from './ports';
import type { ReleaseRecord } from './release';
import type { ReleaseItem } from './render';

/** In-memory adapters of the ports, for tests of this package and of the packages that wire it. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(content: Uint8Array): Promise<string> {
    const sha = sha256Hex(content);
    this.blobs.set(sha, content);
    return sha;
  }
  async get(sha256: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(sha256);
  }
}

export class MemoryCatalogFileStore implements CatalogFileStore {
  readonly rows = new Map<string, StoredFileRow[]>();
  readonly published = new Set<string>();
  async list(catalogVersionId: string): Promise<StoredFileRow[]> {
    return this.rows.get(catalogVersionId) ?? [];
  }
  async replace(catalogVersionId: string, rows: StoredFileRow[]): Promise<void> {
    if (this.published.has(catalogVersionId)) {
      throw new PluginStateError('VERSION_IMMUTABLE', 'published versions are immutable (11.1)');
    }
    this.rows.set(catalogVersionId, rows);
  }
}

export class MemoryMarketplaceStore implements MarketplaceStore {
  readonly marketplaces = new Map<string, MarketplaceRow>();
  /** Items `resolveItems` returns; tests mutate it between releases. */
  current: ResolvedReleaseItem[] = [];
  /** Content of past releases keyed `marketplaceId:seq`, captured by `ReleaseStore.insert`. */
  readonly snapshots = new Map<string, ReleaseItem[]>();

  add(row: MarketplaceRow): void {
    this.marketplaces.set(row.id, row);
  }
  async getBySlug(slug: string): Promise<MarketplaceRow | undefined> {
    return [...this.marketplaces.values()].find((m) => m.slug === slug);
  }
  async getById(id: string): Promise<MarketplaceRow | undefined> {
    return this.marketplaces.get(id);
  }
  async resolveItems(): Promise<ResolvedReleaseItem[]> {
    return this.current;
  }
  async loadReleaseItems(marketplaceId: string, seq: number): Promise<ReleaseItem[]> {
    const items = this.snapshots.get(`${marketplaceId}:${seq}`);
    if (!items) throw new PluginStateError('RELEASE_NOT_FOUND', 'release not found', 404);
    return items;
  }
  async setPromotedRelease(marketplaceId: string, seq: number): Promise<void> {
    const m = this.marketplaces.get(marketplaceId);
    if (m) this.marketplaces.set(marketplaceId, { ...m, promotedRelease: seq });
  }
  async setMirrorStatus(marketplaceId: string, state: MirrorState): Promise<void> {
    const m = this.marketplaces.get(marketplaceId);
    if (m) this.marketplaces.set(marketplaceId, { ...m, mirrorStatus: state });
  }
}

export class MemoryReleaseStore implements ReleaseStore {
  private readonly records = new Map<string, ReleaseRecord[]>();
  constructor(private readonly marketplaces?: MemoryMarketplaceStore) {}

  async get(marketplaceId: string, seq: number): Promise<ReleaseRecord | undefined> {
    return this.records.get(marketplaceId)?.find((r) => r.seq === seq);
  }
  async latest(marketplaceId: string): Promise<ReleaseRecord | undefined> {
    return this.records.get(marketplaceId)?.at(-1);
  }
  async list(marketplaceId: string): Promise<ReleaseRecord[]> {
    return [...(this.records.get(marketplaceId) ?? [])];
  }
  async insert(
    marketplaceId: string,
    record: ReleaseRecord,
    _refs: ReleaseItemRef[],
    _createdBy?: string | null,
  ): Promise<void> {
    const list = this.records.get(marketplaceId) ?? [];
    if (list.some((r) => r.seq === record.seq)) {
      throw new PluginStateError('RELEASE_EXISTS', 'releases are immutable');
    }
    list.push(record);
    this.records.set(marketplaceId, list);
    if (this.marketplaces) {
      this.marketplaces.snapshots.set(`${marketplaceId}:${record.seq}`, [
        ...this.marketplaces.current,
      ]);
    }
  }
}

export class MemoryEventSink implements DistributionEventSink {
  readonly events: DistributionEvent[] = [];
  async record(event: DistributionEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Tokens map to principals; `audience` maps marketplace ids to the principal ids allowed in. */
export class MemoryPluginAccess implements PluginAccess {
  readonly tokens = new Map<string, PluginPrincipal>();
  readonly audience = new Map<string, Set<string>>();
  async authenticate(secret: string): Promise<PluginPrincipal | undefined> {
    return this.tokens.get(secret);
  }
  async canView(principal: PluginPrincipal, marketplace: MarketplaceRow): Promise<boolean> {
    return this.audience.get(marketplace.id)?.has(principal.id) ?? false;
  }
}
