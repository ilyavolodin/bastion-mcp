/**
 * The operations Bastion answers itself (6.3): `initialize` and `notifications/initialized` (legacy), `server/discover`
 * (modern), `ping`, and the four aggregated lists.
 */
import { PROTOCOL_VERSIONS } from '@bastion-mcp/core';
import { listResult, type EffectiveEndpoint, type ItemKind } from '@bastion-mcp/router';
import { TASKS_EXTENSION } from '@bastion-mcp/mcp-upstream';
import { InvalidParamsError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { isRecord } from './support';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const SKILLS_CAPABILITY = { directoryRead: true } as const;

/** Capabilities of an endpoint (7.6): what the router computed, plus extensions Bastion serves itself. */
export const serverCapabilities = (
  endpoint: EffectiveEndpoint,
  options: { skills: boolean; tasks: boolean; logging: boolean },
): JsonObject => {
  const extensions: JsonObject = {
    ...(options.skills ? { [SKILLS_EXTENSION]: SKILLS_CAPABILITY } : {}),
    ...(options.tasks ? { [TASKS_EXTENSION]: {} } : {}),
  };
  return {
    ...endpoint.capabilities,
    ...(options.logging ? { logging: {} } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
};

/** Tasks are declared when the request declares them and the endpoint has something to route them to (6.8). */
export const tasksDeclared = (ctx: Pick<OpContext, 'clientCapabilities' | 'resolved'>): boolean => {
  const ext = ctx.clientCapabilities.extensions;
  return isRecord(ext) && TASKS_EXTENSION in ext && ctx.resolved.installations.size > 0;
};

/** The latest legacy version at or below what the client asked for, else the latest legacy version (2025 negotiation). */
export const negotiateLegacyVersion = (requested: unknown): string => {
  const legacy: readonly string[] = PROTOCOL_VERSIONS.legacy;
  return typeof requested === 'string' && legacy.includes(requested)
    ? requested
    : (legacy[0] ?? PROTOCOL_VERSIONS.default);
};

export const createInitialize = (deps: OperationDeps): Operation => ({
  method: 'initialize',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    if (typeof params.protocolVersion !== 'string') {
      throw new InvalidParamsError('protocolVersion is required');
    }
    if (!isRecord(params.capabilities)) throw new InvalidParamsError('capabilities are required');
    if (!isRecord(params.clientInfo) || typeof params.clientInfo.name !== 'string') {
      throw new InvalidParamsError('clientInfo is required');
    }
    const endpoint = ctx.endpoint;
    return {
      kind: 'complete',
      result: {
        protocolVersion: negotiateLegacyVersion(params.protocolVersion),
        capabilities: serverCapabilities(endpoint, {
          skills: deps.skills !== undefined,
          tasks: false,
          logging: true,
        }),
        serverInfo: endpoint.serverInfo,
        ...(endpoint.instructions === undefined ? {} : { instructions: endpoint.instructions }),
      },
    };
  },
});

export const createInitialized = (): Operation => ({
  method: 'notifications/initialized',
  async run(): Promise<OpOutcome<JsonObject>> {
    return { kind: 'complete', result: {} };
  },
});

export const createDiscover = (deps: OperationDeps): Operation => ({
  method: 'server/discover',
  async run(_params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const endpoint = ctx.endpoint;
    return {
      kind: 'complete',
      result: {
        supportedVersions: [...PROTOCOL_VERSIONS.modern],
        capabilities: serverCapabilities(endpoint, {
          skills: deps.skills !== undefined,
          tasks: tasksDeclared(ctx),
          logging: false,
        }),
        serverInfo: endpoint.serverInfo,
        ...(endpoint.instructions === undefined ? {} : { instructions: endpoint.instructions }),
        ttlMs: endpoint.ttlMs,
        cacheScope: endpoint.cacheScope,
      },
    };
  },
});

export const createPing = (): Operation => ({
  method: 'ping',
  async run(): Promise<OpOutcome<JsonObject>> {
    return { kind: 'complete', result: {} };
  },
});

const LIST_KINDS: Record<string, ItemKind> = {
  'tools/list': 'tool',
  'prompts/list': 'prompt',
  'resources/list': 'resource',
  'resources/templates/list': 'resourceTemplate',
};

export const LIST_METHODS = Object.keys(LIST_KINDS);

export const createList = (deps: OperationDeps, method: string): Operation => {
  const kind = LIST_KINDS[method];
  if (kind === undefined) throw new Error(`${method} is not a list method`);
  return {
    method,
    async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
      const cursor = params.cursor;
      if (cursor !== undefined && typeof cursor !== 'string') {
        throw new InvalidParamsError('cursor must be a string');
      }
      return {
        kind: 'complete',
        result: listResult(ctx.endpoint, kind, {
          pageSize: deps.settings.listPageSize,
          cursor,
        }),
      };
    },
  };
};
