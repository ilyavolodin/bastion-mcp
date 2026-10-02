/**
 * `bastionRequestContext` (6.2): the authenticated context of one HTTP request, populated by the Fastify hooks before
 * the MCP layer runs. The adapters and the SDK factory read it, so nothing derives identity from headers twice.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@bastion-mcp/auth';
import type { ParsedEndpointPath } from '@bastion-mcp/router';
import type { JsonObject, ResolvedEndpoint } from './types';

export type BastionRequestContext = {
  principal: Principal;
  /** `request.raw.auth` as the SDK passes it on (`authInfo`). */
  authInfo: { token: string; clientId: string; scopes: string[]; expiresAt?: number };
  /** SHA-256 of the bearer token, for the legacy session record. */
  tokenHash: string;
  resolved: ResolvedEndpoint;
  endpointPath: ParsedEndpointPath;
  requestUrl: string;
  path: string;
  ip: string;
  origin: 'client' | 'plugin';
  /** Lower-cased request headers as received. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body of a POST (undefined for GET and DELETE). */
  body?: unknown;
  /** `params._meta` of the JSON-RPC request, when there is one. */
  meta?: JsonObject | undefined;
};

export const bastionRequestContext = new AsyncLocalStorage<BastionRequestContext>();

export const currentRequestContext = (): BastionRequestContext => {
  const ctx = bastionRequestContext.getStore();
  if (!ctx) throw new Error('no authenticated request context (bastionRequestContext is empty)');
  return ctx;
};
