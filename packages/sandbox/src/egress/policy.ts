import { timingSafeEqual } from 'node:crypto';
import {
  type AddressPolicy,
  ipInCidr,
  isAddressDenied,
  matchEgressRule,
  normalizeIpLiteral,
  tryParseEgressRule,
} from '@bastion-mcp/core';
import { sha256Hex } from '../supply-chain';

/** Pure egress decisions (8.8). I/O (DNS, sockets, Redis) lives in the proxy and the ports. */

export type EgressPhase = 'installing' | 'starting' | 'running' | (string & {});

/** Value of the Redis hash `egress:{instanceId}` (written by the owner at start and on every phase change). */
export type EgressPolicy = { tokenSha256: string; allow: string[]; phase: EgressPhase };

export interface EgressPolicyStore {
  get(instanceId: string): Promise<EgressPolicy | null>;
}

export type EgressProtocol = 'connect' | 'http';

export type DenyReason =
  | 'unknown-instance'
  | 'bad-credentials'
  | 'bad-request'
  | 'not-allowlisted'
  | 'ssrf-blocked'
  | 'unresolvable'
  | 'connect-failed';

/** Constant-time comparison of a presented token against the stored hash. */
export const verifyEgressToken = (token: string, tokenSha256: string): boolean => {
  const presented = Buffer.from(sha256Hex(token), 'hex');
  const stored = Buffer.from(tokenSha256.toLowerCase(), 'hex');
  return stored.length === presented.length && timingSafeEqual(presented, stored);
};

/** Decodes `Proxy-Authorization: Basic base64(<instanceId>:<egressToken>)`. */
export const parseProxyAuthorization = (
  header: string | undefined,
): { instanceId: string; token: string } | null => {
  const match = /^Basic ([A-Za-z0-9+/=_-]+)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1] as string, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  return { instanceId: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
};

/** `HTTPS_PROXY` URL the runner receives (8.8). */
export const buildProxyUrl = (instanceId: string, token: string, address: string): string =>
  `http://${encodeURIComponent(instanceId)}:${encodeURIComponent(token)}@${address}`;

/** Parses the authority of a CONNECT target or absolute-form URL host: `host`, `host:port`, `[v6]:port`. */
export const parseHostPort = (
  authority: string,
  defaultPort: number,
): { host: string; port: number } | null => {
  let host: string;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest !== '' && !rest.startsWith(':')) return null;
    portText = rest === '' ? undefined : rest.slice(1);
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon >= 0 && authority.indexOf(':') !== colon) return null; // bare IPv6 without brackets
    host = colon >= 0 ? authority.slice(0, colon) : authority;
    portText = colon >= 0 ? authority.slice(colon + 1) : undefined;
  }
  if (host === '' || /[\s/\\@]/.test(host)) return null;
  const port = portText === undefined ? defaultPort : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (portText !== undefined && !/^\d+$/.test(portText))) {
    return null;
  }
  return { host: host.toLowerCase().replace(/\.$/, ''), port };
};

/**
 * Canonical host for matching: IPv4 literals in decimal, octal or hex forms (the usual SSRF encodings) become
 * dotted quads, so `2130706433` is checked as `127.0.0.1` (23.3).
 */
export const canonicalHost = (host: string): string => normalizeIpLiteral(host) ?? host;

/** Extra allow rules for the registry mirrors, valid only while `phase` is `installing` (8.8). */
export const mirrorRules = (urls: readonly (string | undefined)[]): string[] => {
  const rules = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const port = url.port || (url.protocol === 'http:' ? '80' : '443');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    rules.add(`${host}:${port}`);
    // The public PyPI index serves package files from a separate host.
    if (host === 'pypi.org') rules.add(`files.pythonhosted.org:${port}`);
  }
  return [...rules];
};

export type NameDecision =
  | { allowed: true; via: 'allowlist' | 'mirror' }
  | { allowed: false; via: 'none' };

/** Name-level match against the instance allowlist (and the mirrors during `installing`). */
export const matchName = (input: {
  host: string;
  port: number;
  protocol: EgressProtocol;
  policy: EgressPolicy;
  mirrorRules: readonly string[];
}): NameDecision => {
  const host = canonicalHost(input.host);
  if (matchEgressRule(host, input.port, input.policy.allow, { protocol: input.protocol })) {
    return { allowed: true, via: 'allowlist' };
  }
  if (
    input.policy.phase === 'installing' &&
    matchEgressRule(host, input.port, input.mirrorRules, { protocol: input.protocol })
  ) {
    return { allowed: true, via: 'mirror' };
  }
  return { allowed: false, via: 'none' };
};

export const cidrRules = (allow: readonly string[]): string[] =>
  allow.filter((rule) => tryParseEgressRule(rule)?.kind === 'cidr').map((r) => r.trim().toLowerCase());

export type ResolvedDecision =
  | { allowed: true; address: string; via: 'allowlist' | 'mirror' | 'cidr' }
  | { allowed: false; reason: 'not-allowlisted' | 'ssrf-blocked' };

/**
 * Final decision once the name was resolved ONCE (8.8): every resolved address must pass the SSRF check
 * (loopback, link-local incl. 169.254.169.254, RFC 1918, CGNAT, ULA, cluster CIDRs) unless a CIDR rule
 * allows it, and the name or a CIDR rule must allow the target. The caller connects to `address` itself.
 *
 * Mirrors are trusted admin configuration: their addresses skip the private-range and cluster checks but
 * never the cloud metadata addresses.
 */
export const decideResolved = (input: {
  host: string;
  port: number;
  protocol: EgressProtocol;
  policy: EgressPolicy;
  mirrorRules: readonly string[];
  addresses: readonly string[];
  clusterCidrs?: readonly string[];
}): ResolvedDecision => {
  const name = matchName(input);
  const cidrs = cidrRules(input.policy.allow);
  const inAllowedCidr = (ip: string): boolean => cidrs.some((cidr) => ipInCidr(ip, cidr));
  const first = input.addresses[0];
  if (first === undefined) return { allowed: false, reason: 'not-allowlisted' };
  const viaCidr = input.addresses.every(inAllowedCidr);
  if (!name.allowed && !viaCidr) return { allowed: false, reason: 'not-allowlisted' };

  const ssrf: AddressPolicy =
    name.allowed && name.via === 'mirror'
      ? { allowCidrs: ['0.0.0.0/0', '::/0'] }
      : { allowCidrs: cidrs, ...(input.clusterCidrs ? { clusterCidrs: input.clusterCidrs } : {}) };
  if (input.addresses.some((ip) => isAddressDenied(ip, ssrf))) {
    return { allowed: false, reason: 'ssrf-blocked' };
  }
  return {
    allowed: true,
    address: first,
    via: name.allowed ? name.via : 'cidr',
  };
};
