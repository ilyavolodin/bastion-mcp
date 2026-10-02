import { ApiError } from '@/api/client';

type GuardErrors = Partial<Record<'jev' | 'llmJudge' | 'classifier', Record<string, string>>>;

const FIELD_OF: Record<string, string> = {
  endpoint: 'endpoint',
  url: 'endpoint',
  model: 'model',
  apiKeySecret: 'secret',
  maliciousLabels: 'maliciousLabels',
  threshold: 'threshold',
  timeoutMs: 'timeoutMs',
};

/** `/jev/model` goes under the JEV card's Model input; anything else shows on the guard's card. */
export function applyServerErrorsToList(error: unknown): GuardErrors {
  const out: GuardErrors = {};
  if (!(error instanceof ApiError)) return out;
  for (const e of error.errors) {
    const [guard, field] = e.path.replace(/^\//, '').split('/');
    if (guard !== 'jev' && guard !== 'llmJudge' && guard !== 'classifier') continue;
    out[guard] ??= {};
    out[guard][(field && FIELD_OF[field]) || '_'] = e.message;
  }
  if (Object.keys(out).length === 0) out.jev = { _: error.message };
  return out;
}
