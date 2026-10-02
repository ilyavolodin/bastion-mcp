import { canonicalJson, redisKeys, sha256Hex, TTL } from '@bastion-mcp/core';
import { z } from 'zod';
import { CHUNK_OVERLAP, chunkText } from '../extract';
import {
  type FetchLike,
  type GuardAction,
  type GuardCache,
  GuardError,
  type GuardFinding,
  type GuardInput,
  type SecretResolver,
  VERDICTS,
  type Verdict,
} from '../types';

/** Shared plumbing for the model guards (13.5): chunking, 24 h caching, HTTP with timeouts. */

export type ModelGuardDeps = {
  fetch: FetchLike;
  secrets: SecretResolver;
  cache?: GuardCache;
};

/** The verdict for one chunk; cached as JSON. Never contains the scanned text. */
export const chunkVerdictSchema = z.object({
  verdict: z.enum(VERDICTS),
  score: z.number().optional(),
  label: z.string(),
  reason: z.string().optional(),
  action: z.enum(['allow', 'warn', 'redact', 'quarantine', 'confirm', 'block']).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ChunkVerdict = {
  verdict: Verdict;
  score?: number | undefined;
  label: string;
  reason?: string | undefined;
  action?: GuardAction | undefined;
  details?: Record<string, unknown> | undefined;
};

export const sourceOf = (input: GuardInput): string =>
  `${input.installation.slug ?? input.installation.installationId}/${input.item.name}`;

/** The state digest stored for the call log instead of the content itself (22.5). */
export const stateDetails = (input: GuardInput, text: string): Record<string, unknown> => ({
  phase: input.phase,
  source: sourceOf(input),
  textSha256: sha256Hex(text),
  chars: text.length,
});

export const configHashOf = (config: unknown, phase: string): string =>
  sha256Hex(canonicalJson({ config, phase })).slice(0, 32);

export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

export const postJson = async (args: {
  fetch: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> => {
  const timeout = AbortSignal.timeout(args.timeoutMs);
  const signal = AbortSignal.any([args.signal, timeout]);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await args.fetch(args.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...args.headers },
      body: JSON.stringify(args.body),
      signal,
    });
  } catch (error) {
    if (args.signal.aborted)
      throw new GuardError('aborted', 'guard call aborted', { cause: error });
    if (timeout.aborted)
      throw new GuardError('timeout', `no answer within ${args.timeoutMs} ms`, { cause: error });
    throw new GuardError('network', 'guard endpoint unreachable', { cause: error });
  }
  if (!response.ok)
    throw new GuardError(`http_${response.status}`, `guard endpoint answered ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    if (timeout.aborted)
      throw new GuardError('timeout', `no answer within ${args.timeoutMs} ms`, { cause: error });
    throw new GuardError('invalid_response', 'guard endpoint returned invalid JSON', {
      cause: error,
    });
  }
};

export const resolveSecret = async (secrets: SecretResolver, name: string): Promise<string> => {
  try {
    return await secrets.resolve(name);
  } catch (error) {
    throw new GuardError('secret_unavailable', `secret ${name} could not be resolved`, {
      cause: error,
    });
  }
};

type Entry = { segment: number; start: number; end: number; text: string };

/**
 * Chunks the input, serves chunks from the cache when possible, asks `evaluate` for the rest (in input
 * order) and turns the verdicts into findings addressed to the scanned chunk. When nothing is flagged a
 * single `clean` finding carries the highest score and the model details for the call log.
 */
export const runChunked = async (args: {
  input: GuardInput;
  config: unknown;
  chunkSize: number;
  deps: Pick<ModelGuardDeps, 'cache'>;
  evaluate: (texts: string[]) => Promise<ChunkVerdict[]>;
}): Promise<GuardFinding[]> => {
  const { input, deps } = args;
  const entries: Entry[] = [];
  input.segments.forEach((seg, segment) => {
    for (const c of chunkText(seg.text, args.chunkSize, CHUNK_OVERLAP)) {
      const text = seg.text.slice(c.start, c.end);
      if (text.trim() !== '') entries.push({ segment, start: c.start, end: c.end, text });
    }
  });
  if (entries.length === 0) return [];

  const hash = configHashOf(args.config, input.phase);
  const instanceId = input.instanceId ?? 'adhoc';
  const keyOf = (e: Entry): string => redisKeys.guardCache(instanceId, hash, sha256Hex(e.text));
  const verdicts = new Array<ChunkVerdict | undefined>(entries.length);

  if (deps.cache !== undefined) {
    const cache = deps.cache;
    await Promise.all(
      entries.map(async (e, i) => {
        try {
          const raw = await cache.get(keyOf(e));
          if (raw === null) return;
          const parsed = chunkVerdictSchema.safeParse(JSON.parse(raw));
          if (parsed.success) verdicts[i] = parsed.data;
        } catch {
          // A broken cache is a cache miss.
        }
      }),
    );
  }

  const missing = entries.map((e, i) => ({ e, i })).filter(({ i }) => verdicts[i] === undefined);
  if (missing.length > 0) {
    const fresh = await args.evaluate(missing.map(({ e }) => e.text));
    if (fresh.length !== missing.length) {
      throw new GuardError('invalid_response', 'guard returned a different number of verdicts');
    }
    await Promise.all(
      missing.map(async ({ e, i }, k) => {
        const v = fresh[k] as ChunkVerdict;
        verdicts[i] = v;
        if (deps.cache === undefined) return;
        try {
          await deps.cache.set(keyOf(e), JSON.stringify(v), TTL.guardCache);
        } catch {
          // Cache write failures never fail a scan.
        }
      }),
    );
  }

  const findings: GuardFinding[] = [];
  let best: ChunkVerdict | undefined;
  for (const [i, e] of entries.entries()) {
    const v = verdicts[i];
    if (v === undefined) continue;
    if (best === undefined || (v.score ?? 0) > (best.score ?? 0)) best = v;
    if (v.verdict === 'clean') continue;
    findings.push({
      verdict: v.verdict,
      label: v.label,
      category: 'injection',
      spans: [{ segment: e.segment, start: e.start, end: e.end }],
      ...(v.score === undefined ? {} : { score: v.score }),
      ...(v.reason === undefined ? {} : { reason: v.reason }),
      ...(v.action === undefined ? {} : { action: v.action }),
      ...(v.details === undefined ? {} : { details: v.details }),
    });
  }
  if (findings.length === 0 && best !== undefined) {
    findings.push({
      verdict: 'clean',
      label: best.label,
      ...(best.score === undefined ? {} : { score: best.score }),
      ...(best.details === undefined ? {} : { details: best.details }),
    });
  }
  return findings;
};
