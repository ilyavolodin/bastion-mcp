import type {
  DeactivationExecutor,
  PatService,
  PrincipalStore,
  RedisLike,
  SessionService,
  TokenVerifier,
} from '@bastion-mcp/auth';
import type { Limiter } from '@bastion-mcp/limits';
import type { PolicyDataSource, PolicyEngine } from '@bastion-mcp/policy';
import type {
  BlobPort,
  PackageVersionResolver,
  PluginImportPort,
  VersionTestPort,
} from './catalog';
import type { EventBus } from './events';
import type { GuardTester } from './guards';
import type { IdentityPorts } from './identity';
import type {
  InstallationRuntimePort,
  TryPort,
  UpstreamConnectPort,
  UpstreamDefinitionPort,
} from './installations';
import type { AuditReader, CallReader } from './observability';
import type { PluginPorts } from './plugins';
import type { RegistryPorts } from './registry';
import type { SecretsPort } from './secrets';
import type { ResourceStore } from './store';
import type { SystemStatusPort } from './system';
import type { Publisher, UnitOfWork } from './uow';

export type * from './catalog';
export type * from './events';
export type * from './guards';
export type * from './identity';
export type * from './installations';
export type * from './observability';
export type * from './plugins';
export type * from './registry';
export type * from './secrets';
export type * from './store';
export { COLLECTIONS } from './store';
export type * from './system';
export type * from './uow';

export type ApiConfig = {
  /** `https://<host>`: the only trusted origin (resource `https://<host>/api`, 9.3). */
  baseUrl: string;
  /** `BASTION_TRACE_UI_URL` template, shown to the console as a link target (19.1). */
  traceUiUrl?: string;
  /** Maximum time one SSE stream stays open, in seconds (default 3600). */
  sseMaxSeconds?: number;
  /** Heartbeat comment interval of SSE streams in milliseconds (default 15000). */
  sseHeartbeatMs?: number;
};

/**
 * Everything the control-plane API needs from the outside (CONTRIBUTING rule 6). `packages/db` implements
 * `store`, `uow`, `observability`, `secrets` and the registry and plugin stores; `apps/server` wires the rest.
 */
export type ApiDeps = {
  config: ApiConfig;
  auth: {
    tokens: Pick<TokenVerifier, 'verify'>;
    sessions: Pick<SessionService, 'authenticate'>;
  };
  principals: PrincipalStore;
  policy: {
    /** The engine for the current configuration version; cached by the caller. */
    engine(): Promise<PolicyEngine>;
    /** Plain data behind the engine, for `/policies/simulate` and `/policies/validate`. */
    data: PolicyDataSource;
  };
  store: ResourceStore;
  uow: UnitOfWork;
  redis: RedisLike;
  publisher: Publisher;
  events: EventBus;
  pats: Pick<PatService, 'create' | 'list' | 'revoke' | 'revokeAll'>;
  /** Revokes tokens and sessions, stops instances, deletes upstream tokens (9.1). */
  deactivation: DeactivationExecutor;
  secrets: SecretsPort;
  identity: IdentityPorts;
  system: SystemStatusPort;
  catalog: {
    tests: VersionTestPort;
    imports: PluginImportPort;
    versions: PackageVersionResolver;
    blobs: BlobPort;
  };
  installations: {
    definitions: UpstreamDefinitionPort;
    connect: UpstreamConnectPort;
    tryCall: TryPort;
    runtime: InstallationRuntimePort;
  };
  registry: RegistryPorts;
  guards: { tester: GuardTester };
  observability: { calls: CallReader; audit: AuditReader };
  plugins: PluginPorts;
  limits: Pick<Limiter, 'readUsage'>;
  clock: { now(): Date };
  newId(): string;
};
