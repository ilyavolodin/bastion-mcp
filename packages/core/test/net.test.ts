import { describe, expect, it } from 'vitest';
import {
  type AddressClass,
  classifyAddress,
  ipInCidr,
  isAddressDenied,
  matchEgressRule,
  normalizeIpLiteral,
  parseEgressRule,
} from '../src/net';

describe('8.8 / 23.3 SSRF address classification', () => {
  const cases: [string, AddressClass][] = [
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['10.0.0.1', 'private'],
    ['172.16.5.5', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['fd00::1', 'ula'],
    ['0.0.0.0', 'unspecified'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
  ];
  it.each(cases)('%s is %s', (ip, klass) => {
    expect(classifyAddress(ip)).toBe(klass);
  });

  it('normalizes decimal, octal and hex IPv4 encodings', () => {
    expect(normalizeIpLiteral('2130706433')).toBe('127.0.0.1');
    expect(normalizeIpLiteral('0177.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIpLiteral('0x7f.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIpLiteral('example.com')).toBeNull();
  });

  it('denies every non-public class unless an allowed CIDR covers it', () => {
    expect(isAddressDenied('10.1.2.3', {})).toBe(true);
    expect(isAddressDenied('8.8.8.8', {})).toBe(false);
    expect(isAddressDenied('10.1.2.3', { allowCidrs: ['10.0.0.0/8'] })).toBe(false);
    expect(isAddressDenied('169.254.169.254', { allowCidrs: ['169.254.0.0/16'] })).toBe(true); // metadata is never allowed
  });

  it('denies configured cluster CIDRs even when public-looking', () => {
    expect(isAddressDenied('34.10.0.5', { clusterCidrs: ['34.10.0.0/16'] })).toBe(true);
  });
});

describe('CIDR helpers', () => {
  it('matches v4 and v6 CIDRs', () => {
    expect(ipInCidr('10.2.3.4', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.2.3.4', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('fd12::1', 'fd00::/8')).toBe(true);
    expect(ipInCidr('10.0.0.1', 'fd00::/8')).toBe(false);
  });
});

describe('8.8 egress allowlist', () => {
  it('parses host[:port], *.suffix[:port] and CIDR rules', () => {
    expect(parseEgressRule('api.github.com')).toEqual({
      kind: 'host',
      host: 'api.github.com',
      port: undefined,
    });
    expect(parseEgressRule('*.atlassian.net:443')).toEqual({
      kind: 'suffix',
      suffix: 'atlassian.net',
      port: 443,
    });
    expect(parseEgressRule('10.20.0.0/16')).toEqual({ kind: 'cidr', cidr: '10.20.0.0/16' });
  });

  it('matches exact hosts and defaults the port to 443 for CONNECT and 80 for HTTP', () => {
    expect(
      matchEgressRule('api.github.com', 443, ['api.github.com'], { protocol: 'connect' }),
    ).toBe(true);
    expect(matchEgressRule('api.github.com', 80, ['api.github.com'], { protocol: 'connect' })).toBe(
      false,
    );
    expect(matchEgressRule('api.github.com', 80, ['api.github.com'], { protocol: 'http' })).toBe(
      true,
    );
  });

  it('suffix rules match subdomains but not the bare suffix or lookalikes', () => {
    const rules = ['*.atlassian.net'];
    expect(matchEgressRule('acme.atlassian.net', 443, rules, { protocol: 'connect' })).toBe(true);
    expect(matchEgressRule('atlassian.net', 443, rules, { protocol: 'connect' })).toBe(false);
    expect(matchEgressRule('evilatlassian.net', 443, rules, { protocol: 'connect' })).toBe(false);
  });

  it('CIDR rules match resolved IPs', () => {
    expect(matchEgressRule('10.20.1.1', 443, ['10.20.0.0/16'], { protocol: 'connect' })).toBe(true);
    expect(matchEgressRule('10.21.1.1', 443, ['10.20.0.0/16'], { protocol: 'connect' })).toBe(
      false,
    );
  });

  it('is case-insensitive on hosts', () => {
    expect(
      matchEgressRule('API.GitHub.com', 443, ['api.github.com'], { protocol: 'connect' }),
    ).toBe(true);
  });
});
