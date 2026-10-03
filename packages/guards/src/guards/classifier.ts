import { z } from 'zod';
import { CHUNK_SIZES } from '../extract';
import {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type Guard,
  GuardError,
  type GuardInput,
  MAX_GUARD_TIMEOUT_MS,
} from '../types';
import {
  type ChunkVerdict,
  type ModelGuardDeps,
  postJson,
  resolveSecret,
  runChunked,
  stateDetails,
} from './model-common';

/**
 * `classifier` (13.5): a self-hosted sequence classifier behind a Hugging Face Text Embeddings Inference
 * `/predict` endpoint. Content never leaves the deployment.
 */

const MAX_BATCH = 32;

export const classifierConfigSchema = z.object({
  url: z.url(),
  /** Header carrying the credential, with the org secret that holds its value. */
  auth: z.object({ header: z.string().min(1), secret: z.string().min(1) }).optional(),
  /** Labels that mean "malicious", for example `["MALICIOUS", "LABEL_1"]`. */
  maliciousLabels: z.array(z.string().min(1)).min(1),
  threshold: z.number().min(0).max(1).default(0.5),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_GUARD_TIMEOUT_MS)
    .default(DEFAULT_CLASSIFIER_TIMEOUT_MS),
});
export type ClassifierConfig = z.infer<typeof classifierConfigSchema>;

const predictionSchema = z.array(z.array(z.object({ label: z.string(), score: z.number() })));

export const createClassifierGuard = (deps: ModelGuardDeps): Guard<ClassifierConfig> => {
  const classify = async (
    config: ClassifierConfig,
    input: GuardInput,
    texts: string[],
    signal: AbortSignal,
  ): Promise<ChunkVerdict[]> => {
    const headers: Record<string, string> = {};
    if (config.auth !== undefined) {
      headers[config.auth.header] = await resolveSecret(deps.secrets, config.auth.secret);
    }
    const out: ChunkVerdict[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const raw = await postJson({
        fetch: deps.fetch,
        url: config.url,
        headers,
        body: { inputs: batch },
        timeoutMs: config.timeoutMs,
        signal,
      });
      const parsed = predictionSchema.safeParse(raw);
      if (!parsed.success || parsed.data.length !== batch.length) {
        throw new GuardError('invalid_response', 'classifier response has an unexpected shape');
      }
      parsed.data.forEach((labels, k) => {
        const score = Math.max(
          0,
          ...labels.filter((l) => config.maliciousLabels.includes(l.label)).map((l) => l.score),
        );
        const text = batch[k] as string;
        out.push({
          verdict: score >= config.threshold ? 'malicious' : 'clean',
          label: 'classifier',
          score,
          reason: `classifier score ${score.toFixed(2)}`,
          details: { ...stateDetails(input, text), score, threshold: config.threshold },
        });
      });
    }
    return out;
  };

  return {
    type: 'classifier',
    configSchema: classifierConfigSchema,
    async evaluate(input, config, signal) {
      return runChunked({
        input,
        config,
        chunkSize: CHUNK_SIZES.classifier,
        deps,
        evaluate: (texts) => classify(config, input, texts, signal),
      });
    },
  };
};
