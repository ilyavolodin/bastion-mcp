import { slugify } from '@bastion-mcp/core';
import { InstallRequestForbiddenError, InstallRequestStateError } from './errors';
import type { RuntimeKind } from './mapping';
import { type InstallActor, isAdmin, type Risk } from './policy';
import type { InstallRequest, RegistryTrust } from './ports';
import type { ServerJson } from './server-json';

/** Install requests and install plans (11.7). Pure state machine; persistence and execution are the caller's. */

export const MAX_JUSTIFICATION_LENGTH = 2000;

/** Describes one audit-log row for the caller to persist; every install, request and decision has one. */
export type RegistryAuditEvent = {
  action:
    | 'registry.install'
    | 'registry.install_request.create'
    | 'registry.install_request.approve'
    | 'registry.install_request.reject'
    | 'registry.install_request.cancel';
  actorId: string;
  targetType: 'registry_server' | 'install_request';
  targetId: string;
  at: Date;
  metadata: Record<string, unknown>;
};

/** What the api layer executes for a `direct` install (11.7). */
export type InstallPlan = {
  /** Create or reuse the catalog entry for this registry server. */
  catalogEntry: {
    source: { registrySourceId: string; serverName: string; version: string };
    slug: string;
    displayName: string;
    description: string;
    risk: Risk;
    /** Visible only to the requester until a manager promotes it to the store. */
    visibility: { org: false; teamIds: string[]; userIds: string[] };
    /** The catalog version pins the registry version. */
    pinnedVersion: string;
    runtime: RuntimeKind;
    reuseExisting: true;
  };
  /** Lockfile capture, snapshot and guard scan run before the installation is created. */
  automaticTest: true;
  installation: { userId: string; origin: 'registry' };
};

export const buildInstallPlan = (input: {
  requesterId: string;
  sourceId: string;
  serverJson: ServerJson;
  version: string;
  risk: Risk;
  runtime: RuntimeKind;
}): InstallPlan => {
  const { serverJson } = input;
  const last = serverJson.name.split('/').pop() ?? serverJson.name;
  return {
    catalogEntry: {
      source: {
        registrySourceId: input.sourceId,
        serverName: serverJson.name,
        version: input.version,
      },
      slug: slugify(last) || slugify(serverJson.name) || 'registry-server',
      displayName: serverJson.title ?? last,
      description: serverJson.description,
      risk: input.risk,
      visibility: { org: false, teamIds: [], userIds: [input.requesterId] },
      pinnedVersion: input.version,
      runtime: input.runtime,
      reuseExisting: true,
    },
    automaticTest: true,
    installation: { userId: input.requesterId, origin: 'registry' },
  };
};

/** Audit description of a `direct` install, written when the plan is executed (11.7). */
export const describeInstall = (input: {
  actorId: string;
  sourceId: string;
  serverName: string;
  version: string;
  runtime: RuntimeKind;
  trust: RegistryTrust;
  at: Date;
  requestId?: string;
}): RegistryAuditEvent => ({
  action: 'registry.install',
  actorId: input.actorId,
  targetType: 'registry_server',
  targetId: `${input.sourceId}:${input.serverName}@${input.version}`,
  at: input.at,
  metadata: {
    sourceId: input.sourceId,
    serverName: input.serverName,
    version: input.version,
    runtime: input.runtime,
    trust: input.trust,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  },
});

// --- State machine --------------------------------------------------------------------------------------------------

export type Transition = { request: InstallRequest; audit: RegistryAuditEvent };

const baseMetadata = (request: InstallRequest): Record<string, unknown> => ({
  requesterId: request.requesterId,
  sourceId: request.sourceId,
  serverName: request.serverName,
  version: request.version,
});

export const createInstallRequest = (input: {
  id: string;
  requesterId: string;
  sourceId: string;
  serverName: string;
  version: string;
  justification: string;
  now: Date;
}): Transition => {
  const justification = input.justification.trim();
  if (justification.length === 0) {
    throw new InstallRequestStateError('a justification is required');
  }
  if (justification.length > MAX_JUSTIFICATION_LENGTH) {
    throw new InstallRequestStateError(
      `the justification is longer than ${MAX_JUSTIFICATION_LENGTH} characters`,
    );
  }
  const request: InstallRequest = {
    id: input.id,
    requesterId: input.requesterId,
    sourceId: input.sourceId,
    serverName: input.serverName,
    version: input.version,
    justification,
    status: 'open',
    decidedBy: null,
    decidedAt: null,
    reason: null,
    createdAt: input.now,
  };
  return {
    request,
    audit: {
      action: 'registry.install_request.create',
      actorId: input.requesterId,
      targetType: 'install_request',
      targetId: request.id,
      at: input.now,
      metadata: { ...baseMetadata(request), justification },
    },
  };
};

/** Approvers: admins, and managers of at least one of the requester's teams (11.7). */
export const canDecide = (
  request: Pick<InstallRequest, 'requesterId'>,
  actor: InstallActor,
  requesterTeamIds: readonly string[],
): boolean => {
  if (isAdmin(actor)) return true;
  if (actor.id === request.requesterId) return false;
  return actor.managedTeamIds.some((team) => requesterTeamIds.includes(team));
};

/** Users who receive the request: the actors for whom `canDecide` holds. */
export const approverIds = (
  candidates: readonly InstallActor[],
  request: Pick<InstallRequest, 'requesterId'>,
  requesterTeamIds: readonly string[],
): string[] => candidates.filter((c) => canDecide(request, c, requesterTeamIds)).map((c) => c.id);

const assertOpen = (request: InstallRequest): void => {
  if (request.status !== 'open') {
    throw new InstallRequestStateError(`request is already ${request.status}`);
  }
};

const decisionAudit = (
  action: RegistryAuditEvent['action'],
  request: InstallRequest,
  actorId: string,
  at: Date,
  extra: Record<string, unknown> = {},
): RegistryAuditEvent => ({
  action,
  actorId,
  targetType: 'install_request',
  targetId: request.id,
  at,
  metadata: { ...baseMetadata(request), ...extra },
});

export type ApprovalContext = {
  actor: InstallActor;
  requesterTeamIds: readonly string[];
  now: Date;
  /** Resolved by the caller when approving: the mirrored entry the request refers to. */
  serverJson: ServerJson;
  risk: Risk;
  runtime: RuntimeKind;
  trust: RegistryTrust;
};

/** Approval returns the plan of the `direct` flow, executed for the requester (11.7). */
export const approveRequest = (
  request: InstallRequest,
  ctx: ApprovalContext,
): Transition & { plan: InstallPlan; installAudit: RegistryAuditEvent } => {
  assertOpen(request);
  if (!canDecide(request, ctx.actor, ctx.requesterTeamIds)) {
    throw new InstallRequestForbiddenError('only admins and managers of the requester may decide');
  }
  const next: InstallRequest = {
    ...request,
    status: 'approved',
    decidedBy: ctx.actor.id,
    decidedAt: ctx.now,
    reason: null,
  };
  return {
    request: next,
    audit: decisionAudit('registry.install_request.approve', next, ctx.actor.id, ctx.now),
    plan: buildInstallPlan({
      requesterId: request.requesterId,
      sourceId: request.sourceId,
      serverJson: ctx.serverJson,
      version: request.version,
      risk: ctx.risk,
      runtime: ctx.runtime,
    }),
    installAudit: describeInstall({
      actorId: request.requesterId,
      sourceId: request.sourceId,
      serverName: request.serverName,
      version: request.version,
      runtime: ctx.runtime,
      trust: ctx.trust,
      at: ctx.now,
      requestId: request.id,
    }),
  };
};

export const rejectRequest = (
  request: InstallRequest,
  ctx: { actor: InstallActor; requesterTeamIds: readonly string[]; now: Date; reason: string },
): Transition => {
  assertOpen(request);
  if (!canDecide(request, ctx.actor, ctx.requesterTeamIds)) {
    throw new InstallRequestForbiddenError('only admins and managers of the requester may decide');
  }
  const reason = ctx.reason.trim();
  if (reason.length === 0) throw new InstallRequestStateError('a rejection reason is required');
  const next: InstallRequest = {
    ...request,
    status: 'rejected',
    decidedBy: ctx.actor.id,
    decidedAt: ctx.now,
    reason,
  };
  return {
    request: next,
    audit: decisionAudit('registry.install_request.reject', next, ctx.actor.id, ctx.now, {
      reason,
    }),
  };
};

/** Only the requester cancels, and only while the request is open. */
export const cancelRequest = (
  request: InstallRequest,
  ctx: { actorId: string; now: Date },
): Transition => {
  assertOpen(request);
  if (ctx.actorId !== request.requesterId) {
    throw new InstallRequestForbiddenError('only the requester may cancel a request');
  }
  const next: InstallRequest = {
    ...request,
    status: 'cancelled',
    decidedBy: ctx.actorId,
    decidedAt: ctx.now,
  };
  return {
    request: next,
    audit: decisionAudit('registry.install_request.cancel', next, ctx.actorId, ctx.now),
  };
};
