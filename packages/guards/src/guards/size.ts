import { z } from 'zod';
import { totalTextBytes } from '../extract';
import type { Guard } from '../types';

/** `size` (13.4): maximum argument bytes (default 1 MiB) and maximum result bytes (default 16 MiB). */

export const sizeConfigSchema = z.object({
  maxArgumentBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  maxResultBytes: z
    .number()
    .int()
    .positive()
    .default(16 * 1024 * 1024),
});
export type SizeConfig = z.infer<typeof sizeConfigSchema>;

export const sizeGuard: Guard<SizeConfig> = {
  type: 'size',
  configSchema: sizeConfigSchema,
  async evaluate(input, config) {
    if (input.phase === 'definition') return [];
    const limit = input.phase === 'request' ? config.maxArgumentBytes : config.maxResultBytes;
    const bytes = totalTextBytes(input.segments);
    if (bytes <= limit) return [];
    const what = input.phase === 'request' ? 'arguments' : 'result';
    return [
      {
        verdict: 'malicious',
        label: `size-${what}`,
        ruleId: `max-${what}-bytes`,
        action: 'block',
        category: 'policy',
        reason: `${what} are ${bytes} bytes, above the limit of ${limit}`,
        details: { bytes, limit },
      },
    ];
  },
};
