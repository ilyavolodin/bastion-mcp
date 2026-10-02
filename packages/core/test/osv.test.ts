import { describe, expect, it } from 'vitest';
import { checkPackagesAgainstOsv, findMaliciousAdvisories, OsvError } from '../src/osv';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pkgs = [
  { ecosystem: 'npm', name: 'left-pad', version: '1.3.0' },
  { ecosystem: 'PyPI', name: 'evil-pkg', version: '0.0.1' },
] as const;

describe('8.7 OSV malicious-package check', () => {
  it('queries the OSV batch API with one query per package', async () => {
    let body: unknown;
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.osv.dev/v1/querybatch');
      body = JSON.parse(String(init?.body));
      return jsonResponse({ results: [{}, { vulns: [{ id: 'MAL-2026-1' }] }] });
    };
    await checkPackagesAgainstOsv(pkgs, { fetch: fetchFn });
    expect(body).toEqual({
      queries: [
        { package: { ecosystem: 'npm', name: 'left-pad' }, version: '1.3.0' },
        { package: { ecosystem: 'PyPI', name: 'evil-pkg' }, version: '0.0.1' },
      ],
    });
  });

  it('flags only MAL- advisories as malicious, leaving ordinary CVEs alone', async () => {
    const fetchFn = async () =>
      jsonResponse({
        results: [
          { vulns: [{ id: 'GHSA-xxxx' }, { id: 'CVE-2026-1' }] },
          { vulns: [{ id: 'MAL-2026-1' }] },
        ],
      });
    const result = await checkPackagesAgainstOsv(pkgs, { fetch: fetchFn });
    expect(findMaliciousAdvisories(result)).toEqual([
      { package: pkgs[1], advisoryIds: ['MAL-2026-1'] },
    ]);
  });

  it('returns no findings for clean results', async () => {
    const fetchFn = async () => jsonResponse({ results: [{}, {}] });
    expect(
      findMaliciousAdvisories(await checkPackagesAgainstOsv(pkgs, { fetch: fetchFn })),
    ).toEqual([]);
  });

  it('fails closed on HTTP errors, malformed bodies and result count mismatches', async () => {
    await expect(
      checkPackagesAgainstOsv(pkgs, { fetch: async () => jsonResponse({}, 503) }),
    ).rejects.toThrow(OsvError);
    await expect(
      checkPackagesAgainstOsv(pkgs, { fetch: async () => jsonResponse({ nope: 1 }) }),
    ).rejects.toThrow(OsvError);
    await expect(
      checkPackagesAgainstOsv(pkgs, { fetch: async () => jsonResponse({ results: [{}] }) }),
    ).rejects.toThrow(OsvError);
  });

  it('every outbound call has a timeout signal', async () => {
    let signal: AbortSignal | null | undefined;
    await checkPackagesAgainstOsv(pkgs, {
      fetch: async (_url, init) => {
        signal = init?.signal;
        return jsonResponse({ results: [{}, {}] });
      },
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('splits more than 1,000 packages into several batches', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      ecosystem: 'npm' as const,
      name: `p${i}`,
      version: '1.0.0',
    }));
    const sizes: number[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const queries = (JSON.parse(String(init?.body)) as { queries: unknown[] }).queries;
      sizes.push(queries.length);
      return jsonResponse({ results: queries.map(() => ({})) });
    };
    const result = await checkPackagesAgainstOsv(many, { fetch: fetchFn });
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(result).toHaveLength(2500);
  });
});
