import { describe, expect, it } from 'vitest';
import { coldStartUrl, parseRunConfig } from '../src/args';

const common = ['--token', 't', '--url', 'https://bastion.test/mcp/i/echo'];

describe('23.1 load generator configuration', () => {
  it('applies the 23.4 defaults for a call scenario', () => {
    const cfg = parseRunConfig([
      '--scenario',
      'call-guards-off',
      ...common,
      '--direct-url',
      'http://upstream:9000/mcp',
    ]);
    expect(cfg.rate).toBe(2000);
    expect(cfg.tool).toBe('echo');
    expect(cfg.out).toBe('results/call-guards-off.json');
  });

  it('requires a direct baseline for added-latency scenarios', () => {
    expect(() => parseRunConfig(['--scenario', 'call-guards-default', ...common])).toThrow(
      /direct-url/,
    );
  });

  it('allows traffic-only runs without a baseline for chaos and upgrade tests', () => {
    const cfg = parseRunConfig(['--scenario', 'call-guards-off', ...common, '--skip-baseline']);
    expect(cfg.skipBaseline).toBe(true);
    expect(cfg.directUrl).toBeUndefined();
  });

  it('defaults listen-streams to 5,000 streams for one hour', () => {
    const cfg = parseRunConfig(['--scenario', 'listen-streams', ...common]);
    expect(cfg.streams).toBe(5000);
    expect(cfg.durationSec).toBe(3600);
  });

  it('collects several --stream-url values', () => {
    const cfg = parseRunConfig([
      '--scenario',
      'listen-streams',
      ...common,
      '--stream-url',
      'http://a/mcp',
      '--stream-url',
      'http://b/mcp',
    ]);
    expect(cfg.streamUrls).toEqual(['http://a/mcp', 'http://b/mcp']);
  });

  it('requires owner and non-owner URLs for forwarded-calls', () => {
    expect(() =>
      parseRunConfig([
        '--scenario',
        'forwarded-calls',
        '--token',
        't',
        '--owner-url',
        'http://a/mcp',
      ]),
    ).toThrow(/non-owner-url/);
    const cfg = parseRunConfig([
      '--scenario',
      'forwarded-calls',
      '--token',
      't',
      '--owner-url',
      'http://a/mcp',
      '--non-owner-url',
      'http://b/mcp',
    ]);
    expect(cfg.url).toBe('http://a/mcp');
  });

  it('reads the token from BASTION_LOAD_TOKEN and rejects a missing one', () => {
    const argv = ['--scenario', 'list-30', '--url', 'https://bastion.test/mcp/e/thirty'];
    expect(parseRunConfig(argv, { BASTION_LOAD_TOKEN: 'abc' }).token).toBe('abc');
    expect(() => parseRunConfig(argv)).toThrow(/token/);
  });

  it('rejects bad numbers, bad JSON arguments and unknown scenarios', () => {
    expect(() => parseRunConfig(['--scenario', 'list-30', ...common, '--rate=0'])).toThrow(
      /positive integer/,
    );
    expect(() => parseRunConfig(['--scenario', 'list-30', ...common, '--args', '[1]'])).toThrow(
      /JSON object/,
    );
    expect(() => parseRunConfig(['--scenario', 'list-30', ...common, '--args', '{'])).toThrow(
      /valid JSON/,
    );
    expect(() => parseRunConfig(['--scenario', 'bogus', ...common])).toThrow(/unknown scenario/);
    expect(() =>
      parseRunConfig(['--scenario', 'list-30', '--token', 't', '--url', 'not a url']),
    ).toThrow(/not a URL/);
  });

  it('builds one installation URL per cold-start iteration', () => {
    expect(coldStartUrl('https://b.test/mcp/i/echo', 'cold-{i}', 7)).toBe(
      'https://b.test/mcp/i/cold-7',
    );
    expect(() => coldStartUrl('https://b.test/mcp', 'cold-{i}', 1)).toThrow(/mcp\/i/);
  });
});
