/**
 * Contracts between the parts of the composition root. Each part is built by one file and consumed through these
 * types, so parts can be written and tested independently (CONTRIBUTING rule 6).
 */
import type {
  AuthorizationServer,
  DeactivationExecutor,
  IdpClients,
  IdpLogin,
  IdpTokenVault,
  PatService,
  PrincipalStore,
  RevocationStore,
  ScimService,
  SessionService,
  TokenVerifier,
  UpstreamCredentialResolver,
  UpstreamOAuthBroker,
} from '@bastion-mcp/auth';
import type { Keyring } from '@bastion-mcp/core';
import type { KeyStore } from '@bastion-mcp/secrets';

/** Identity, OAuth and credential services (adapters/auth.ts). */
export type AuthServices = {
  /** Live keyring of `state` keys: mutated in place when `refreshKeys` runs, so holders never go stale (22.3). */
  stateKeyring: Keyring;
  keyStore: KeyStore;
  principalStore: PrincipalStore;
  revocations: RevocationStore;
  verifier: TokenVerifier;
  sessions: SessionService;
  pats: PatService;
  deactivation: DeactivationExecutor;
  /** The worker registers how to stop a principal's instances (9.1 deactivation step 4). */
  setInstanceStopper(stop: (principalId: string) => Promise<void>): void;
  authorizationServer: AuthorizationServer;
  idpLogin: IdpLogin;
  idpClients: IdpClients;
  idpTokens: IdpTokenVault;
  broker: UpstreamOAuthBroker;
  /** Implements mcp-upstream's `UpstreamCredentialProvider` after adapting (adapters/upstream). */
  credentials: UpstreamCredentialResolver;
  scim: ScimService;
  /** Reloads the state keyring and the authorization server's JWKS (after rotation or `signing_keys` events). */
  refreshKeys(): Promise<void>;
  close(): Promise<void>;
};

// --- policy, guards, limits: shared by the worker (hot path) and the ui role (API, simulate, test flows) ----------

import type { createGuardRegistry, GuardPipeline, RiskStore } from '@bastion-mcp/guards';
import type { Limiter } from '@bastion-mcp/limits';
import type { Downstream, GuardProfilePort, LimitRulesPort } from '@bastion-mcp/mcp-downstream';
import type { UpstreamRuntime } from '@bastion-mcp/mcp-upstream';
import type { PolicyDataSource, PolicyEngine } from '@bastion-mcp/policy';
import type { SandboxDriver } from '@bastion-mcp/sandbox';
import type { FastifyInstance } from 'fastify';

/** The compiled Cedar engine for the current configuration; rebuilt on `bastion:config` events (10, 4.3). */
export type PolicyService = {
  /** Synchronous current engine for the hot path (`PolicyPort.current`). Throws before the first `rebuild`. */
  current(): PolicyEngine;
  /** The engine for the current config version, rebuilding when stale (`ApiDeps.policy.engine`). */
  engine(): Promise<PolicyEngine>;
  data: PolicyDataSource;
  rebuild(): Promise<void>;
  /** Subscribes to `bastion:config` and rebuilds; returns the unsubscribe function. */
  watch(): () => void;
};

export type GuardService = {
  pipeline: GuardPipeline;
  registry: ReturnType<typeof createGuardRegistry>;
  profiles: GuardProfilePort;
  risk: RiskStore;
};

export type LimitService = {
  limiter: Limiter;
  rules: LimitRulesPort;
  /** Subscribes to `bastion:config` to refresh cached rules. */
  watch(): () => void;
};

// --- worker role -------------------------------------------------------------------------------------------------------

export type DriverState = {
  name: 'kubernetes' | 'bubblewrap' | string;
  healthy: boolean;
  detail?: string;
};

/** Everything the worker role runs (adapters/worker.ts / roles/worker.ts). */
export type WorkerServices = {
  runtime: UpstreamRuntime;
  downstream: Downstream;
  driver: SandboxDriver;
  driverState(): Promise<DriverState>;
  /** Registers `/mcp`, `/mcp/*` and `/.well-known/oauth-protected-resource/*` on a Fastify app. */
  registerRoutes(app: FastifyInstance): Promise<void>;
  /** Starts heartbeats, the internal RPC listener, the egress proxy and the Redis subscriptions. */
  start(): Promise<void>;
  /** SIGTERM drain (21.2): stop leases, finish in-flight work up to `graceMs` (default 25 s), close streams. */
  stop(graceMs?: number): Promise<void>;
  /** Port the internal RPC server listens on (0 until `start`). */
  internalRpcPort(): number;
  internalRpcListening(): boolean;
};
