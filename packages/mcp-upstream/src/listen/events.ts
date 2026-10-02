import { REDIS_CHANNELS } from '@bastion-mcp/core';
import type {
  ListChangedPublisher,
  ListKind,
  Logger,
  NotifyTargets,
  RedisLike,
  ResolvedInstallation,
} from '../ports';
import { noopLogger } from '../ports';

/** `{ targets, endpointIds?, kind, uri? }` published on `bastion:notify` (6.6). Each worker filters by its own streams. */
export type NotifyKind =
  | 'tools_list_changed'
  | 'prompts_list_changed'
  | 'resources_list_changed'
  | 'resource_updated';

export type NotifyEvent = {
  targets: NotifyTargets;
  endpointIds?: string[] | undefined;
  kind: NotifyKind;
  /** The DOWNSTREAM URI, with any rewrite reversed (6.6). */
  uri?: string | undefined;
};

const KIND_OF: Record<ListKind, NotifyKind> = {
  tools: 'tools_list_changed',
  prompts: 'prompts_list_changed',
  resources: 'resources_list_changed',
};

export class NotifyPublisher implements ListChangedPublisher {
  constructor(
    private readonly redis: RedisLike,
    private readonly logger: Logger = noopLogger,
  ) {}

  async publish(event: NotifyEvent): Promise<void> {
    try {
      await this.redis.publish(REDIS_CHANNELS.notify, JSON.stringify(event));
    } catch (error) {
      this.logger.warn('could not publish a notification event', { error: String(error) });
    }
  }

  /** Who is told: the installation's configured targets, else the principal whose connection saw the change. */
  static targetsFor(
    installation: ResolvedInstallation,
    fallbackPrincipalId?: string,
  ): NotifyTargets {
    if (installation.notifyTargets) return installation.notifyTargets;
    const principal = fallbackPrincipalId ?? installation.ownerUserId ?? undefined;
    return principal === undefined ? { all: false } : { principalIds: [principal] };
  }

  async listChanged(
    installation: ResolvedInstallation,
    kinds: ListKind[],
    fallbackPrincipalId?: string,
  ): Promise<void> {
    const targets = NotifyPublisher.targetsFor(installation, fallbackPrincipalId);
    for (const kind of kinds) await this.publish({ targets, kind: KIND_OF[kind] });
  }

  async resourceUpdated(
    installation: ResolvedInstallation,
    downstreamUri: string,
    fallbackPrincipalId?: string,
  ): Promise<void> {
    await this.publish({
      targets: NotifyPublisher.targetsFor(installation, fallbackPrincipalId),
      kind: 'resource_updated',
      uri: downstreamUri,
    });
  }
}

/** Reverses the URI index rewrite so `notifications/resources/updated` reaches subscribers of the downstream URI (6.6, 7.4). */
export interface UriMapper {
  /** Downstream URI(s) of an upstream URI of this installation; empty when nobody maps to it. */
  toDownstream(installationId: string, upstreamUri: string): string[];
  /** The upstream URI for a downstream subscription (the URI index, 7.4). */
  toUpstream(installationId: string, downstreamUri: string): string;
}

export const identityUriMapper: UriMapper = {
  toDownstream: (_installationId, uri) => [uri],
  toUpstream: (_installationId, uri) => uri,
};
