import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  type AddressPolicy,
  addressFamily,
  BastionError,
  blockedAddressMessage,
  isAddressDenied,
  normalizeIpLiteral,
  pinnedLookup,
} from '@bastion-mcp/core';
import { Agent, type Dispatcher } from 'undici';
import type { FetchFn } from './ports';

/** SSRF guard for every discovery, registration and token endpoint call (9.6, 23.3). */
export class OutboundDeniedError extends BastionError {
  constructor(message: string) {
    super('OUTBOUND_DENIED', message, { httpStatus: 403 });
  }
}

export type OutboundPolicy = {
  addressPolicy?: AddressPolicy;
  /** Resolves a hostname to every address; defaults to the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Permit plain http only when the target address is inside an admin-allowed CIDR. Default false. */
  allowHttpToAllowedCidrs?: boolean;
  timeoutMs?: number;
};

const defaultLookup = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address);

const stripBrackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

export type OutboundTarget = { url: URL; address: string; family: 4 | 6 };

/**
 * Validates the URL and resolves its host ONCE; the caller must connect to the returned address (8.8, 8.9).
 * Throws OutboundDeniedError unless the URL is https (or http to an admin-allowed address) and public.
 */
export const resolveOutboundTarget = async (
  raw: string,
  policy: OutboundPolicy = {},
): Promise<OutboundTarget> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundDeniedError('invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundDeniedError('only http(s) URLs are allowed');
  }
  if (url.username || url.password) throw new OutboundDeniedError('credentials in URL');
  const host = stripBrackets(url.hostname);
  const literal = isIP(host) ? host : normalizeIpLiteral(host);
  const addresses = literal ? [literal] : await (policy.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new OutboundDeniedError('host did not resolve');
  const addressPolicy = policy.addressPolicy ?? {};
  for (const address of addresses) {
    if (isAddressDenied(address, addressPolicy)) {
      throw new OutboundDeniedError(blockedAddressMessage(host, address));
    }
  }
  if (url.protocol === 'http:') {
    const allowedInternal =
      policy.allowHttpToAllowedCidrs === true &&
      addresses.every((address) => isAddressDenied(address, {}));
    if (!allowedInternal) throw new OutboundDeniedError('https is required');
  }
  const first = addresses[0] as string;
  return { url, address: first, family: addressFamily(first) };
};

/** Throws OutboundDeniedError unless the URL is https (or http to an admin-allowed address) and public. */
export const assertOutboundUrl = async (raw: string, policy: OutboundPolicy = {}): Promise<URL> =>
  (await resolveOutboundTarget(raw, policy)).url;

const MAX_AGENTS = 64;
const agents = new Map<string, Agent>();

/** One keep-alive dispatcher per validated address; its connections can only reach that address. */
const pinnedDispatcher = (target: OutboundTarget): Dispatcher => {
  const key = target.address;
  const existing = agents.get(key);
  if (existing) return existing;
  if (agents.size >= MAX_AGENTS) {
    const oldest = agents.keys().next().value;
    if (oldest !== undefined) {
      void agents
        .get(oldest)
        ?.close()
        .catch(() => undefined);
      agents.delete(oldest);
    }
  }
  const agent = new Agent({
    keepAliveTimeout: 10_000,
    connect: { lookup: pinnedLookup(target), timeout: 10_000 },
  });
  agents.set(key, agent);
  return agent;
};

/** Wraps a fetch: checks the URL, pins the connection to the checked address, never follows redirects, applies a timeout. */
export const createSafeFetch = (inner: FetchFn, policy: OutboundPolicy = {}): FetchFn => {
  const safe = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const resolved = await resolveOutboundTarget(target, policy);
    const signals: AbortSignal[] = [AbortSignal.timeout(policy.timeoutMs ?? 10_000)];
    if (init?.signal) signals.push(init.signal);
    return inner(input, {
      ...init,
      dispatcher: pinnedDispatcher(resolved),
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    } as unknown as RequestInit);
  };
  return safe as FetchFn;
};
