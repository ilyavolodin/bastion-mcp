import { createClassifierGuard } from './guards/classifier';
import { createJevGuard } from './guards/jev';
import { createLlmJudgeGuard } from './guards/llm-judge';
import type { ModelGuardDeps } from './guards/model-common';
import { piiGuard } from './guards/pii';
import { regexGuard } from './guards/regex';
import { sizeGuard } from './guards/size';
import { unicodeGuard } from './guards/unicode';
import { urlGuard } from './guards/url';
import { defineGuard, type RegisteredGuard } from './types';

/** The deterministic guards: always available, no I/O. */
export const deterministicGuards = (): RegisteredGuard[] => [
  defineGuard(unicodeGuard),
  defineGuard(sizeGuard),
  defineGuard(regexGuard),
  defineGuard(piiGuard),
  defineGuard(urlGuard),
];

/**
 * All guard implementations. Model guards need an HTTP client and a secret resolver; without `modelDeps`
 * they are not registered and an instance of that type fails with `unknown_guard` (its `failMode`).
 */
export const createGuardRegistry = (
  modelDeps?: ModelGuardDeps & { systemPrompt?: string },
): RegisteredGuard[] => {
  const guards = deterministicGuards();
  if (modelDeps !== undefined) {
    guards.push(
      defineGuard(createClassifierGuard(modelDeps)),
      defineGuard(createJevGuard(modelDeps)),
      defineGuard(createLlmJudgeGuard(modelDeps)),
    );
  }
  return guards;
};
