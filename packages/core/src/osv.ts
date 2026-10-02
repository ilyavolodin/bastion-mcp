import { z } from 'zod';

/**
 * OSV.dev malicious-package check (8.7 lockfiles, 11.7 `requireOsvClean`). Shared by the sandbox and
 * registry packages; `fetch` is injectable so callers and tests control the network.
 */

export type OsvPackage = { ecosystem: 'npm' | 'PyPI'; name: string; version: string };
export type OsvPackageResult = { package: OsvPackage; advisoryIds: string[] };
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OsvError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OsvError';
  }
}

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const BATCH_SIZE = 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

const responseSchema = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).optional() })),
});

/** Advisories for every package, in input order. Throws `OsvError` on anything unexpected (fail closed). */
export const checkPackagesAgainstOsv = async (
  packages: readonly OsvPackage[],
  options: { fetch?: FetchFn; baseUrl?: string; timeoutMs?: number } = {},
): Promise<OsvPackageResult[]> => {
  const fetchFn = options.fetch ?? fetch;
  const results: OsvPackageResult[] = [];
  for (let start = 0; start < packages.length; start += BATCH_SIZE) {
    const batch = packages.slice(start, start + BATCH_SIZE);
    let response: Response;
    try {
      response = await fetchFn(options.baseUrl ?? OSV_BATCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: batch.map((p) => ({
            package: { ecosystem: p.ecosystem, name: p.name },
            version: p.version,
          })),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new OsvError('OSV request failed', { cause: error });
    }
    if (!response.ok) throw new OsvError(`OSV answered HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new OsvError('OSV answered an unexpected body');
    if (parsed.data.results.length !== batch.length) {
      throw new OsvError('OSV result count does not match the query count');
    }
    batch.forEach((pkg, i) => {
      const ids = (parsed.data.results[i]?.vulns ?? []).map((v) => v.id);
      results.push({ package: pkg, advisoryIds: ids });
    });
  }
  return results;
};

/** Only `MAL-` advisories (known-malicious packages) block; ordinary CVEs do not (8.7). */
export const findMaliciousAdvisories = (results: readonly OsvPackageResult[]): OsvPackageResult[] =>
  results
    .map((r) => ({
      package: r.package,
      advisoryIds: r.advisoryIds.filter((id) => id.startsWith('MAL-')),
    }))
    .filter((r) => r.advisoryIds.length > 0);
