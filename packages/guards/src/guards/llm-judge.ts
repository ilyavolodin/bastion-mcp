import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CHUNK_SIZES } from '../extract';
import { type Guard, GuardError, type GuardInput } from '../types';
import {
  type ChunkVerdict,
  type ModelGuardDeps,
  mapLimit,
  postJson,
  resolveSecret,
  runChunked,
  stateDetails,
} from './model-common';

/**
 * `llmJudge` (13.5): any OpenAI-compatible Chat Completions endpoint judges the content. The content sits
 * in the user message between boundary markers made of a random 16-hex token; the system prompt (file
 * `prompts/injection-judge.md`) says that everything between the markers is data.
 */

/** Loads the versioned system prompt shipped with the package. */
export const loadInjectionJudgePrompt = (): string =>
  readFileSync(new URL('../../prompts/injection-judge.md', import.meta.url), 'utf8');

export const judgeConfigSchema = z.object({
  /** Full Chat Completions URL, for example `https://llm.internal/v1/chat/completions`. */
  endpoint: z.url(),
  model: z.string().min(1),
  /** Org secret holding the bearer token; omit for endpoints without auth. */
  apiKeySecret: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(3000),
});
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;

export const JUDGE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'injection_verdict',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['clean', 'suspicious', 'malicious'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
      },
      required: ['verdict', 'confidence', 'reason'],
      additionalProperties: false,
    },
  },
} as const;

const verdictSchema = z.object({
  verdict: z.enum(['clean', 'suspicious', 'malicious']),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export const buildJudgeMessages = (
  systemPrompt: string,
  text: string,
  token: string,
): { role: 'system' | 'user'; content: string }[] => [
  { role: 'system', content: systemPrompt.replaceAll('{{token}}', token) },
  { role: 'user', content: `<<<DATA ${token}>>>\n${text}\n<<<END ${token}>>>` },
];

const newToken = (text: string): string => {
  let token = randomBytes(8).toString('hex');
  while (text.includes(token)) token = randomBytes(8).toString('hex');
  return token;
};

export const createLlmJudgeGuard = (
  deps: ModelGuardDeps & { systemPrompt?: string },
): Guard<JudgeConfig> => {
  let prompt = deps.systemPrompt;
  const judge = async (
    config: JudgeConfig,
    input: GuardInput,
    text: string,
    signal: AbortSignal,
  ): Promise<ChunkVerdict> => {
    prompt ??= loadInjectionJudgePrompt();
    const headers: Record<string, string> = {};
    if (config.apiKeySecret !== undefined) {
      headers.authorization = `Bearer ${await resolveSecret(deps.secrets, config.apiKeySecret)}`;
    }
    const raw = await postJson({
      fetch: deps.fetch,
      url: config.endpoint,
      headers,
      body: {
        model: config.model,
        messages: buildJudgeMessages(prompt, text, newToken(text)),
        response_format: JUDGE_RESPONSE_FORMAT,
        temperature: 0,
        max_tokens: 200,
      },
      timeoutMs: config.timeoutMs,
      signal,
    });
    const completion = completionSchema.safeParse(raw);
    const first = completion.success ? completion.data.choices[0] : undefined;
    let parsed: z.ZodSafeParseResult<z.infer<typeof verdictSchema>> | undefined;
    if (first !== undefined) {
      try {
        parsed = verdictSchema.safeParse(JSON.parse(first.message.content));
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined || !parsed.success) {
      throw new GuardError('invalid_response', 'judge response failed schema validation');
    }
    const { verdict, confidence, reason } = parsed.data;
    return {
      verdict,
      label: 'llm-judge',
      score: confidence,
      reason: reason.slice(0, 300),
      details: { ...stateDetails(input, text), modelVersion: config.model, verdict, confidence },
    };
  };

  return {
    type: 'llmJudge',
    configSchema: judgeConfigSchema,
    async evaluate(input, config, signal) {
      return runChunked({
        input,
        config,
        chunkSize: CHUNK_SIZES.llmJudge,
        deps,
        evaluate: (texts) => mapLimit(texts, 4, (text) => judge(config, input, text, signal)),
      });
    },
  };
};
