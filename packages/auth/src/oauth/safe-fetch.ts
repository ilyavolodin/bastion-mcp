import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  type AddressPolicy,
  BastionError,
  isAddressDenied,
  normalizeIpLiteral,
} from '@bastion-mcp/core';
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

/** Throws OutboundDeniedError unless the URL is https (or http to an admin-allowed address) and public. */
export const assertOutboundUrl = async (raw: string, policy: OutboundPolicy = {}): Promise<URL> => {
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
      throw new OutboundDeniedError('destination address is not allowed');
    }
  }
  if (url.protocol === 'http:') {
    const allowedInternal =
      policy.allowHttpToAllowedCidrs === true &&
      addresses.every((address) => isAddressDenied(address, {}));
    if (!allowedInternal) throw new OutboundDeniedError('https is required');
  }
  return url;
};

/** Wraps a fetch: checks the URL, never follows redirects, applies a timeout. */
export const createSafeFetch = (inner: FetchFn, policy: OutboundPolicy = {}): FetchFn => {
  const safe = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    await assertOutboundUrl(target, policy);
    const signals: AbortSignal[] = [AbortSignal.timeout(policy.timeoutMs ?? 10_000)];
    if (init?.signal) signals.push(init.signal);
    return inner(input, { ...init, redirect: 'manual', signal: AbortSignal.any(signals) });
  };
  return safe as FetchFn;
};
