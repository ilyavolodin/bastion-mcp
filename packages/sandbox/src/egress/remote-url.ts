import type { LookupFunction } from 'node:net';
import net from 'node:net';
import { BastionError, isAddressDenied } from '@bastion-mcp/core';
import { canonicalHost } from './policy';
import { type Resolver, systemResolver } from './proxy';

/** Remote connector SSRF checks (8.9): the same address rules as the egress proxy. */

export class UnsafeRemoteUrlError extends BastionError {
  constructor(message: string, data: { reason: string }) {
    super('UNSAFE_REMOTE_URL', message, { httpStatus: 400, data });
  }
}

export type SafeRemoteUrl = {
  url: URL;
  /** The single address the name resolved to; connect to this exact address (DNS-rebinding safe). */
  address: string;
  family: 4 | 6;
  port: number;
};

export type RemoteUrlOptions = {
  /**
   * `BASTION_PRIVATE_UPSTREAM_CIDRS` for admin-authored catalog entries; pass `[]` for personal
   * installations, which never reach private ranges (8.9).
   */
  privateCidrsAllowed: readonly string[];
  /** `BASTION_INSECURE_UPSTREAM_HOSTS`: hosts allowed over plain HTTP (development only). */
  insecureHosts: readonly string[];
  resolver?: Resolver;
};

const fail = (reason: string, message: string): never => {
  throw new UnsafeRemoteUrlError(message, { reason });
};

/** Validates a remote upstream URL and resolves its host ONCE (8.9, 23.3). */
export const assertSafeRemoteUrl = async (
  raw: string,
  options: RemoteUrlOptions,
): Promise<SafeRemoteUrl> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('invalid-url', 'remote URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return fail('scheme', `remote URL scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) return fail('credentials', 'remote URL must not embed credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol === 'http:') {
    const allowed = options.insecureHosts.map((h) => h.toLowerCase());
    if (!allowed.includes(hostname) && !allowed.includes(url.host.toLowerCase())) {
      return fail('insecure', 'remote URL must use HTTPS');
    }
  }
  const host = canonicalHost(hostname);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (options.resolver ?? systemResolver)(host);
    } catch {
      return fail('unresolvable', `remote host ${hostname} did not resolve`);
    }
  }
  const first = addresses[0];
  if (first === undefined) return fail('unresolvable', `remote host ${hostname} did not resolve`);
  for (const address of addresses) {
    if (isAddressDenied(address, { allowCidrs: options.privateCidrsAllowed })) {
      return fail('blocked-address', `remote host ${hostname} resolves to a blocked address`);
    }
  }
  return { url, address: first, family: net.isIPv6(first) ? 6 : 4, port };
};

/** `lookup` for undici/`net.connect` that always answers the pinned address, whatever name is asked. */
export const pinnedLookup =
  (pinned: Pick<SafeRemoteUrl, 'address' | 'family'>): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: pinned.address, family: pinned.family },
      ]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
