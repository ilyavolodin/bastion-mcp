/** `EndpointProvider` (26) and `UpstreamProvider`, the one v1 implementation (7.2). */
import type {
  UpstreamPrompt,
  UpstreamResource,
  UpstreamResourceTemplate,
  UpstreamTool,
} from '@bastion-mcp/overrides';
import type { InstallationInfo, UpstreamItems } from './types';

export type ProviderContext = {
  principalId: string;
  endpointId: string;
  signal?: AbortSignal | undefined;
};

/** Which layer served a list; useful for metrics and the UI. */
export type ListOrigin = 'cache' | 'live' | 'snapshot' | 'reference' | 'started';

export type UpstreamListResult =
  | { status: 'ok'; items: UpstreamItems; origin: ListOrigin }
  | { status: 'degraded'; code: string; detail?: string };

/**
 * Port: loads one installation's upstream lists from the cache, the live instance or the latest snapshot
 * (see `chooseListSource`). `mcp-upstream` and `db` implement it. It must not throw for expected failures;
 * the provider also converts a thrown error into a degraded result.
 */
export interface UpstreamItemSource {
  listItems(installation: InstallationInfo, ctx: ProviderContext): Promise<UpstreamListResult>;
}

export type Operation = {
  method: 'tools/call' | 'prompts/get' | 'resources/read' | 'completion/complete';
  name?: string;
  uri?: string;
  arguments?: Record<string, unknown>;
};

export type OpOutcome = { result: unknown };

/** Port: performs an operation on the upstream (implemented by `mcp-upstream`). */
export interface UpstreamCaller {
  call(installation: InstallationInfo, op: Operation, ctx: ProviderContext): Promise<OpOutcome>;
}

export type ProviderListing =
  | { status: 'ok'; items: UpstreamItems }
  | { status: 'degraded'; code: string; detail?: string };

export interface EndpointProvider {
  kind: 'upstream' | 'native';
  /** The installation this provider stands for (a native provider describes itself the same way). */
  readonly installation: InstallationInfo;
  listTools(ctx: ProviderContext): Promise<UpstreamTool[]>;
  listPrompts(ctx: ProviderContext): Promise<UpstreamPrompt[]>;
  listResources(ctx: ProviderContext): Promise<UpstreamResource[]>;
  listResourceTemplates(ctx: ProviderContext): Promise<UpstreamResourceTemplate[]>;
  /** One load for everything, so the compiler hits the source once per installation. */
  listAll?(ctx: ProviderContext): Promise<ProviderListing>;
  call(op: Operation, ctx: ProviderContext): Promise<OpOutcome>;
}

export class UpstreamProvider implements EndpointProvider {
  readonly kind = 'upstream' as const;
  private readonly pending = new WeakMap<object, Promise<ProviderListing>>();

  constructor(
    readonly installation: InstallationInfo,
    private readonly source: UpstreamItemSource,
    private readonly caller?: UpstreamCaller,
  ) {}

  /** Never throws: a failing installation is reported as degraded and skipped (7.5). */
  listAll(ctx: ProviderContext): Promise<ProviderListing> {
    const cached = this.pending.get(ctx);
    if (cached) return cached;
    const run = (async (): Promise<ProviderListing> => {
      try {
        const result = await this.source.listItems(this.installation, ctx);
        return result.status === 'ok'
          ? { status: 'ok', items: result.items }
          : {
              status: 'degraded',
              code: result.code,
              ...(result.detail === undefined ? {} : { detail: result.detail }),
            };
      } catch {
        return { status: 'degraded', code: 'list_failed' };
      }
    })();
    this.pending.set(ctx, run);
    return run;
  }

  private async items(ctx: ProviderContext): Promise<UpstreamItems> {
    const listing = await this.listAll(ctx);
    if (listing.status === 'degraded') throw new Error(`list degraded: ${listing.code}`);
    return listing.items;
  }

  async listTools(ctx: ProviderContext): Promise<UpstreamTool[]> {
    return (await this.items(ctx)).tools;
  }
  async listPrompts(ctx: ProviderContext): Promise<UpstreamPrompt[]> {
    return (await this.items(ctx)).prompts;
  }
  async listResources(ctx: ProviderContext): Promise<UpstreamResource[]> {
    return (await this.items(ctx)).resources;
  }
  async listResourceTemplates(ctx: ProviderContext): Promise<UpstreamResourceTemplate[]> {
    return (await this.items(ctx)).resourceTemplates;
  }

  async call(op: Operation, ctx: ProviderContext): Promise<OpOutcome> {
    if (!this.caller) throw new Error('UpstreamProvider has no UpstreamCaller configured');
    return this.caller.call(this.installation, op, ctx);
  }
}

/** Loads a provider through `listAll` when it has one, otherwise through the four list methods. */
export const loadProvider = async (
  provider: EndpointProvider,
  ctx: ProviderContext,
): Promise<ProviderListing> => {
  if (provider.listAll) return provider.listAll(ctx);
  try {
    const [tools, prompts, resources, resourceTemplates] = await Promise.all([
      provider.listTools(ctx),
      provider.listPrompts(ctx),
      provider.listResources(ctx),
      provider.listResourceTemplates(ctx),
    ]);
    return { status: 'ok', items: { tools, prompts, resources, resourceTemplates } };
  } catch {
    return { status: 'degraded', code: 'list_failed' };
  }
};
