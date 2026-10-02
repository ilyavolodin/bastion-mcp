import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Address checks shared by the egress proxy (8.8), remote connectors (8.9) and SSRF tests (23.3).
 * Pure functions: callers resolve DNS once and pass the resolved address.
 */

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'link-local'
  | 'private'
  | 'cgnat'
  | 'ula'
  | 'unspecified'
  | 'multicast'
  | 'reserved';

type Family = 'ipv4' | 'ipv6';

const RANGES: { cidr: string; family: Family; klass: AddressClass }[] = [
  { cidr: '0.0.0.0/8', family: 'ipv4', klass: 'unspecified' },
  { cidr: '10.0.0.0/8', family: 'ipv4', klass: 'private' },
  { cidr: '100.64.0.0/10', family: 'ipv4', klass: 'cgnat' },
  { cidr: '127.0.0.0/8', family: 'ipv4', klass: 'loopback' },
  { cidr: '169.254.0.0/16', family: 'ipv4', klass: 'link-local' },
  { cidr: '172.16.0.0/12', family: 'ipv4', klass: 'private' },
  { cidr: '192.0.0.0/24', family: 'ipv4', klass: 'reserved' },
  { cidr: '192.168.0.0/16', family: 'ipv4', klass: 'private' },
  { cidr: '198.18.0.0/15', family: 'ipv4', klass: 'reserved' },
  { cidr: '224.0.0.0/4', family: 'ipv4', klass: 'multicast' },
  { cidr: '240.0.0.0/4', family: 'ipv4', klass: 'reserved' },
  { cidr: '::/128', family: 'ipv6', klass: 'unspecified' },
  { cidr: '::1/128', family: 'ipv6', klass: 'loopback' },
  { cidr: 'fc00::/7', family: 'ipv6', klass: 'ula' },
  { cidr: 'fe80::/10', family: 'ipv6', klass: 'link-local' },
  { cidr: 'ff00::/8', family: 'ipv6', klass: 'multicast' },
];

const blockLists = RANGES.map((range) => {
  const list = new BlockList();
  const [net, prefix] = range.cidr.split('/') as [string, string];
  list.addSubnet(net, Number(prefix), range.family);
  return { ...range, list };
});

const familyOf = (ip: string): Family | null => {
  const v = isIP(ip);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : null;
};

/** Returns the embedded IPv4 of an IPv4-mapped IPv6 literal (`::ffff:a.b.c.d` or `::ffff:7f00:1`). */
const unmap = (ip: string): string => {
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1] as string;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
};

/** Classifies a literal IP. Unparseable input is `reserved`, so callers fail closed. */
export const classifyAddress = (ip: string): AddressClass => {
  const address = unmap(ip);
  const family = familyOf(address);
  if (!family) return 'reserved';
  for (const range of blockLists) {
    if (range.family === family && range.list.check(address, family)) return range.klass;
  }
  return 'public';
};

/**
 * Normalizes IPv4 literals written as one decimal number, octal or hex parts (inet_aton forms),
 * the encodings SSRF payloads use. Returns null when `host` is not an IPv4 literal.
 */
export const normalizeIpLiteral = (host: string): string | null => {
  if (isIP(host)) return host;
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) n = Number.parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = Number.parseInt(part, 8);
    else if (/^(0|[1-9]\d*)$/.test(part)) n = Number.parseInt(part, 10);
    else return null;
    nums.push(n);
  }
  const last = nums.pop() as number;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let value = last;
  nums.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
};

export const ipInCidr = (ip: string, cidr: string): boolean => {
  const [net, prefix] = cidr.split('/');
  const address = unmap(ip);
  const family = familyOf(address);
  const netFamily = net ? familyOf(net) : null;
  if (!family || !net || !netFamily || family !== netFamily || prefix === undefined) return false;
  const list = new BlockList();
  list.addSubnet(net, Number(prefix), netFamily);
  return list.check(address, family);
};

export type AddressPolicy = {
  /** CIDRs that may be reached even though they are private (admin-authored entries, egress allow). */
  allowCidrs?: readonly string[];
  /** Pod and service CIDRs that are always denied (`BASTION_CLUSTER_CIDRS`). */
  clusterCidrs?: readonly string[];
};

const METADATA_ADDRESSES = ['169.254.169.254', 'fd00:ec2::254'] as const;

/** True when connecting to the resolved address must be refused (8.8). */
export const isAddressDenied = (ip: string, policy: AddressPolicy): boolean => {
  const address = unmap(ip);
  if (METADATA_ADDRESSES.includes(address as (typeof METADATA_ADDRESSES)[number])) return true;
  if (policy.clusterCidrs?.some((cidr) => ipInCidr(address, cidr))) return true;
  if (classifyAddress(address) === 'public') return false;
  return !policy.allowCidrs?.some((cidr) => ipInCidr(address, cidr));
};

// --- Egress allowlist (8.8) --------------------------------------------------------------------------------------
export type EgressRule =
  | { kind: 'host'; host: string; port: number | undefined }
  | { kind: 'suffix'; suffix: string; port: number | undefined }
  | { kind: 'cidr'; cidr: string };

const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Parses `host[:port]`, `*.suffix[:port]` or a CIDR; returns null for anything else. */
export const tryParseEgressRule = (raw: string): EgressRule | null => {
  const value = raw.trim().toLowerCase();
  if (value.includes('/')) {
    const [net, prefix] = value.split('/') as [string, string];
    const family = familyOf(net);
    const max = family === 'ipv4' ? 32 : family === 'ipv6' ? 128 : -1;
    return /^\d+$/.test(prefix) && Number(prefix) <= max ? { kind: 'cidr', cidr: value } : null;
  }
  const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(value);
  const hostPart = portMatch?.[1] ?? '';
  const port = portMatch?.[2] === undefined ? undefined : Number(portMatch[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  if (hostPart.startsWith('*.')) {
    const suffix = hostPart.slice(2);
    return HOSTNAME.test(suffix) ? { kind: 'suffix', suffix, port } : null;
  }
  return HOSTNAME.test(hostPart) || familyOf(hostPart)
    ? { kind: 'host', host: hostPart, port }
    : null;
};

export const parseEgressRule = (raw: string): EgressRule => {
  const rule = tryParseEgressRule(raw);
  if (!rule) throw new TypeError(`invalid egress rule "${raw}"`);
  return rule;
};

export const isValidEgressRule = (raw: string): boolean => tryParseEgressRule(raw) !== null;

/** Whether `host:port` is allowed. Ports default to 443 for CONNECT and 80 for plain HTTP. */
export const matchEgressRule = (
  host: string,
  port: number,
  rules: readonly string[],
  options: { protocol: 'connect' | 'http' },
): boolean => {
  const target = host.toLowerCase();
  const defaultPort = options.protocol === 'connect' ? 443 : 80;
  return rules.some((raw) => {
    const rule = tryParseEgressRule(raw);
    if (!rule) return false;
    if (rule.kind === 'cidr') return familyOf(target) !== null && ipInCidr(target, rule.cidr);
    if ((rule.port ?? defaultPort) !== port) return false;
    if (rule.kind === 'host') return rule.host === target;
    return target.endsWith(`.${rule.suffix}`);
  });
};

/** 4 or 6 for an IP literal. */
export const addressFamily = (ip: string): 4 | 6 => (isIP(ip) === 6 ? 6 : 4);

/**
 * `lookup` for undici/`net.connect` that always answers the pre-validated address, whatever name is asked:
 * resolve once, check, then connect to that exact address (DNS-rebinding safe, 8.8, 8.9).
 */
export const pinnedLookup =
  (pinned: { address: string; family: number }): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: pinned.address, family: pinned.family },
      ]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
