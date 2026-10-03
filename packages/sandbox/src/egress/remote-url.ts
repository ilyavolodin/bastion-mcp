import {
  BastionError,
  blockedAddressMessage,
  isMetadataAddress,
  pinnedLookup,
  resolveAndCheckUrl,
  UrlCheckError,
} from '@bastion-mcp/core';
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

/** The shared explanation of core, with the rule that personal installations never reach private networks. */
const remoteBlockedMessage = (hostname: string, address: string): string => {
  const message = blockedAddressMessage(`remote host ${hostname}`, address);
  return isMetadataAddress(address)
    ? message
    : `${message}. Personal installations can never reach private networks`;
};

/** Validates a remote upstream URL and resolves its host ONCE (8.9, 23.3). */
export const assertSafeRemoteUrl = async (
  raw: string,
  options: RemoteUrlOptions,
): Promise<SafeRemoteUrl> => {
  const resolver = options.resolver ?? systemResolver;
  const insecure = options.insecureHosts.map((h) => h.toLowerCase());
  try {
    const checked = await resolveAndCheckUrl(raw, {
      addressPolicy: { allowCidrs: options.privateCidrsAllowed },
      lookup: (host) => resolver(canonicalHost(host)),
      allowHttp: (url, hostname) =>
        insecure.includes(hostname.toLowerCase()) || insecure.includes(url.host.toLowerCase()),
    });
    const { url } = checked;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return { url, address: checked.address, family: checked.family, port };
  } catch (error) {
    if (!(error instanceof UrlCheckError)) throw error;
    return failFrom(error, raw);
  }
};

const failFrom = (error: UrlCheckError, raw: string): never => {
  const host = error.detail?.host ?? '';
  switch (error.reason) {
    case 'invalid-url':
      return fail('invalid-url', 'remote URL is not a valid URL');
    case 'scheme':

    case 'credentials':
      return fail('credentials', 'remote URL must not embed credentials');
    case 'insecure':
      return fail(
        'insecure',
        `remote URL must use HTTPS. To use plain HTTP for ${host}, an administrator must add it to BASTION_INSECURE_UPSTREAM_HOSTS and restart Bastion (only for networks you trust)`,
      );
    case 'unresolvable':
      return fail('unresolvable', `remote host ${host} did not resolve`);
    case 'blocked-address':
      return fail(
        'blocked-address',
        remoteBlockedMessage(host, error.detail?.address ?? new URL(raw).hostname),
      );
  }
};

export { pinnedLookup };
