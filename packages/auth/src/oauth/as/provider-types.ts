import type { Provider } from 'oidc-provider';
import type { ResourceServerInfo } from './resource-server';

/**
 * `@types/oidc-provider` lags the 9.12 runtime: these narrow views describe the parts of the runtime API
 * that Bastion uses and the typings omit. The cast is confined to this file.
 */
export type RuntimeGrant = {
  readonly accountId: string;
  readonly clientId: string;
  addOIDCScope(scope: string): void;
  addResourceScope(resource: string, scope: string): void;
  save(ttlSeconds?: number): Promise<string>;
};

export type RuntimeAccessToken = {
  resourceServer: unknown;
  scope: string;
  readonly expiration: number;
  readonly tokenType: string;
  save(): Promise<string>;
};

export type RuntimeSession = { destroy(): Promise<void> };

export type RuntimeProvider = {
  Session: { findByUid(uid: string): Promise<RuntimeSession | undefined> };
  AccessToken: new (props: Record<string, unknown>) => RuntimeAccessToken;
  ResourceServer: new (identifier: string, info: ResourceServerInfo) => unknown;
  Grant: (new (props: {
    accountId: string;
    clientId: string;
  }) => RuntimeGrant) & {
    find(id: string): Promise<RuntimeGrant | undefined>;
  };
};

export const runtime = (provider: Provider): RuntimeProvider =>
  provider as unknown as RuntimeProvider;
