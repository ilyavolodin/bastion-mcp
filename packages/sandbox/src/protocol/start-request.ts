import { z } from 'zod';

/** Request and event bodies of the runner HTTP API (8.3). */

export const bindRequestSchema = z.object({ token: z.string().min(16).max(512) });
export type BindRequest = z.infer<typeof bindRequestSchema>;

export const START_PHASES = ['installing', 'starting', 'ready', 'failed'] as const;
export type StartPhase = (typeof START_PHASES)[number];

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const startRequestSchema = z.object({
  runtime: z.enum(['npm', 'pypi']),
  identifier: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  bin: z.string().min(1).max(256).optional(),
  lockfile: z
    .object({
      kind: z.enum(['npm-shrinkwrap', 'uv-requirements']),
      content: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  allowInstallScripts: z.boolean().default(false),
  args: z.array(z.string()).default([]),
  env: z.record(envName, z.string()).default({}),
  registry: z
    .object({ npm: z.string().url().optional(), pypi: z.string().url().optional() })
    .default({}),
  egress: z.object({ proxyUrl: z.string().url() }),
});
export type StartRequest = z.infer<typeof startRequestSchema>;
export type StartRequestInput = z.input<typeof startRequestSchema>;

export const startEventSchema = z.object({
  phase: z.enum(START_PHASES),
  detail: z.string(),
  elapsedMs: z.number().nonnegative(),
});
export type StartEvent = z.infer<typeof startEventSchema>;

export const healthResponseSchema = z.object({ state: z.enum(['unbound', 'bound', 'running']) });
export type RunnerStateName = z.infer<typeof healthResponseSchema>['state'];
