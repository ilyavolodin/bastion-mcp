import type { Principal } from '@bastion-mcp/auth';
import { DEFAULT_LIMIT_RULES, type Keyring } from '@bastion-mcp/core';
import type { GuardPipeline } from '@bastion-mcp/guards';
import { ORG_DEFAULT_PROFILE } from '@bastion-mcp/guards';
import { compileRulesFor, defaultRules, type Limiter } from '@bastion-mcp/limits';
import type { InstallationRegistry } from '@bastion-mcp/mcp-upstream';
import type { PrincipalData } from '@bastion-mcp/policy';
import type { SeenUriStore } from '@bastion-mcp/router';
import { type BastionMetrics, createMetrics } from '@bastion-mcp/telemetry';
import { metrics as otelMetrics, type Tracer, trace } from '@opentelemetry/api';
import {
  type CallLogPort,
  type Clock,
  type GuardProfilePort,
  type LimitRulesPort,
  type Logger,
  noopLogger,
  type PolicyPort,
  type PrincipalProfilePort,
  type SkillsProvider,
  systemClock,
  type ToPolicyPrincipal,
  type UpstreamPort,
} from '../ports';

/** Cached public reads (6.7): `UpstreamLists.reads` of `mcp-upstream` implements this. */
export interface ReadCachePort {
  get(installationId: string, uri: string): Promise<unknown | undefined>;
  put(installationId: string, uri: string, result: unknown): Promise<boolean>;
}

export type OperationSettings = {
  serverVersion: string;
  /** `BASTION_LIST_PAGE_SIZE` (default 1,000, 7.5). */
  listPageSize: number;
  /** `BASTION_OTEL_CAPTURE_CONTENT` (15.2). */
  captureContent: boolean;
  /** Id of the single organization in Cedar and limits (`org`). */
  orgId: string;
};

export type OperationDeps = {
  upstream: UpstreamPort;
  stateKeyring: Keyring;
  policy: PolicyPort;
  toPolicyPrincipal: ToPolicyPrincipal;
  profiles?: PrincipalProfilePort | undefined;
  limiter: Limiter;
  limitRules: LimitRulesPort;
  guards: GuardPipeline;
  guardProfiles: GuardProfilePort;
  seenUris: SeenUriStore;
  callLog: CallLogPort;
  skills?: SkillsProvider | undefined;
  /** Resolves installation variables and roots (`InstallationRegistry` of `mcp-upstream`). */
  installations: Pick<InstallationRegistry, 'get'>;
  reads?: ReadCachePort | undefined;
  metrics: BastionMetrics;
  tracer: Tracer;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  settings: OperationSettings;
};

export const DEFAULT_SETTINGS: OperationSettings = {
  serverVersion: '0.0.0',
  listPageSize: 1000,
  captureContent: false,
  orgId: 'org',
};

/** The default Cedar principal: what the verified `Principal` alone says (no email domain). */
export const defaultToPolicyPrincipal: ToPolicyPrincipal = (
  principal: Principal,
  profile,
): PrincipalData =>
  principal.type === 'service'
    ? {
        kind: 'service',
        id: principal.id,
        active: principal.active,
        team: { id: principal.teams[0]?.teamId ?? '' },
      }
    : {
        kind: 'user',
        id: principal.id,
        role: principal.orgRole,
        active: principal.active,
        emailDomain: profile.emailDomain ?? '',
        teams: principal.teams.map((t) => ({ id: t.teamId, role: t.role })),
      };

/** The 14.3 defaults, matched per caller and endpoint (14.1). */
export const defaultLimitRulesPort: LimitRulesPort = {
  rulesFor: (op, endpoint) =>
    compileRulesFor(op.principal, { installationIds: endpoint.installationIds }, defaultRules()),
};

export const defaultGuardProfilePort: GuardProfilePort = {
  layersFor: () => ({ org: ORG_DEFAULT_PROFILE }),
};

export const noopMetrics = (): BastionMetrics =>
  createMetrics(otelMetrics.getMeter('bastion-mcp-downstream'));
export const defaultTracer = (): Tracer => trace.getTracer('bastion-mcp-downstream');

export { DEFAULT_LIMIT_RULES, noopLogger, systemClock };
