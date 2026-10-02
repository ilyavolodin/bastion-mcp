import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Deployment configuration (19.1). Everything is validated with zod at start; the loader refuses to
 * start on any invalid value and reports every error at once.
 */

export class ConfigError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super(`invalid configuration:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type EnvSource = Record<string, string | undefined>;

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(fallback);
const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const optionalString = z.string().min(1).optional();
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

const envSchema = z
  .object({
    BASTION_ROLE: z.enum(['worker', 'ui', 'all']).default('all'),
    BASTION_PUBLIC_URL: z.string().url(),
    BASTION_HTTP_PORT: int(8080, 1, 65535),
    BASTION_INTERNAL_PORT: int(7443, 1, 65535),
    BASTION_EGRESS_PORT: int(3128, 1, 65535),
    BASTION_INTERNAL_SECRET: z.string().min(32, 'must be at least 32 bytes'),
    BASTION_INTERNAL_SECRET_PREVIOUS: optionalString,
    BASTION_DATABASE_URL: z.string().min(1),
    BASTION_DATABASE_REPLICA_URL: optionalString,
    BASTION_DATABASE_POOL_MAX: int(20, 1),
    BASTION_REDIS_URL: z.string().min(1),
    BASTION_KMS: z.enum(['local', 'gcp', 'aws', 'azure', 'vault']).default('local'),
    BASTION_KMS_KEY: optionalString,
    BASTION_BOOTSTRAP_ADMIN_EMAIL: optionalString,
    BASTION_LOCAL_LOGIN: bool(false),
    BASTION_SANDBOX_DRIVER: z.enum(['kubernetes', 'bubblewrap']).default('bubblewrap'),
    BASTION_SANDBOX_NAMESPACE: z.string().default('bastion-sandboxes'),
    BASTION_SANDBOX_RUNTIME_CLASS: z.string().default('gvisor'),
    BASTION_SANDBOX_IMAGE: optionalString,
    BASTION_DATA_DIR: z.string().default('/var/lib/bastion'),
    BASTION_MAX_RUNNING_SANDBOXES: int(500, 1),
    BASTION_MAX_RUNNING_INSTANCES_PER_USER: int(10, 1),
    BASTION_NPM_REGISTRY: z.string().url().default('https://registry.npmjs.org'),
    BASTION_PYPI_INDEX_URL: z.string().url().default('https://pypi.org/simple'),
    BASTION_OSV_CHECK: bool(true),
    BASTION_CLUSTER_CIDRS: csv,
    BASTION_PRIVATE_UPSTREAM_CIDRS: csv,
    BASTION_INSECURE_UPSTREAM_HOSTS: csv,
    BASTION_EXTRA_CA_CERTS: optionalString,
    BASTION_LEGACY_MAX_SESSIONS_PER_PRINCIPAL: int(20, 1),
    BASTION_LIST_CACHE_TTL_MS: int(300_000),
    BASTION_LIST_PAGE_SIZE: int(1000, 1),
    BASTION_EXPECTED_WORKERS: int(3, 1),
    BASTION_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
    BASTION_OTEL_CAPTURE_CONTENT: bool(false),
    BASTION_PROMETHEUS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    BASTION_TRACE_UI_URL: optionalString,
    BASTION_LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    BASTION_GIT_CACHE_DIR: z.string().default('/var/cache/bastion/git'),
    BASTION_CONFIG_FILE: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.BASTION_KMS !== 'local' && !env.BASTION_KMS_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['BASTION_KMS_KEY'],
        message: `required when BASTION_KMS is "${env.BASTION_KMS}"`,
      });
    }
    try {
      const url = new URL(env.BASTION_PUBLIC_URL);
      if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
        ctx.addIssue({
          code: 'custom',
          path: ['BASTION_PUBLIC_URL'],
          message: 'must be https unless the host is localhost',
        });
      }
    } catch {
      // reported by the url() check
    }
  });

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const toConfig = (env: z.infer<typeof envSchema>) => {
  const publicUrl = stripTrailingSlash(env.BASTION_PUBLIC_URL);
  return {
    role: env.BASTION_ROLE,
    roles: {
      worker: env.BASTION_ROLE !== 'ui',
      ui: env.BASTION_ROLE !== 'worker',
    },
    publicUrl,
    urls: {
      issuer: `${publicUrl}/oauth`,
      mcpResource: `${publicUrl}/mcp`,
      apiResource: `${publicUrl}/api`,
    },
    httpPort: env.BASTION_HTTP_PORT,
    internalPort: env.BASTION_INTERNAL_PORT,
    egressPort: env.BASTION_EGRESS_PORT,
    internalSecret: env.BASTION_INTERNAL_SECRET,
    internalSecretPrevious: env.BASTION_INTERNAL_SECRET_PREVIOUS,
    databaseUrl: env.BASTION_DATABASE_URL,
    databaseReplicaUrl: env.BASTION_DATABASE_REPLICA_URL,
    databasePoolMax: env.BASTION_DATABASE_POOL_MAX,
    redisUrl: env.BASTION_REDIS_URL,
    kms: env.BASTION_KMS,
    kmsKey: env.BASTION_KMS_KEY,
    bootstrapAdminEmail: env.BASTION_BOOTSTRAP_ADMIN_EMAIL,
    localLogin: env.BASTION_LOCAL_LOGIN,
    sandbox: {
      driver: env.BASTION_SANDBOX_DRIVER,
      namespace: env.BASTION_SANDBOX_NAMESPACE,
      runtimeClass: env.BASTION_SANDBOX_RUNTIME_CLASS,
      image: env.BASTION_SANDBOX_IMAGE,
    },
    dataDir: env.BASTION_DATA_DIR,
    maxRunningSandboxes: env.BASTION_MAX_RUNNING_SANDBOXES,
    maxRunningInstancesPerUser: env.BASTION_MAX_RUNNING_INSTANCES_PER_USER,
    npmRegistry: env.BASTION_NPM_REGISTRY,
    pypiIndexUrl: env.BASTION_PYPI_INDEX_URL,
    osvCheck: env.BASTION_OSV_CHECK,
    clusterCidrs: env.BASTION_CLUSTER_CIDRS,
    privateUpstreamCidrs: env.BASTION_PRIVATE_UPSTREAM_CIDRS,
    insecureUpstreamHosts: env.BASTION_INSECURE_UPSTREAM_HOSTS,
    extraCaCerts: env.BASTION_EXTRA_CA_CERTS,
    legacyMaxSessionsPerPrincipal: env.BASTION_LEGACY_MAX_SESSIONS_PER_PRINCIPAL,
    listCacheTtlMs: env.BASTION_LIST_CACHE_TTL_MS,
    listPageSize: env.BASTION_LIST_PAGE_SIZE,
    expectedWorkers: env.BASTION_EXPECTED_WORKERS,
    traceSampleRatio: env.BASTION_TRACE_SAMPLE_RATIO,
    otelCaptureContent: env.BASTION_OTEL_CAPTURE_CONTENT,
    prometheusPort: env.BASTION_PROMETHEUS_PORT,
    traceUiUrl: env.BASTION_TRACE_UI_URL,
    logLevel: env.BASTION_LOG_LEVEL,
    gitCacheDir: env.BASTION_GIT_CACHE_DIR,
  };
};

export type BastionConfig = ReturnType<typeof toConfig>;

/** Reads a `bastion.yaml` (path `BASTION_CONFIG_FILE`) whose keys mirror the environment variables. */
export const parseConfigFile = (yamlText: string): Record<string, string> => {
  const parsed: unknown = parseYaml(yamlText);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError([{ path: '(file)', message: 'expected a mapping of BASTION_* keys' }]);
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(',') : String(value),
    ]),
  );
};

/** Environment wins over the file. Throws `ConfigError` listing every invalid value. */
export const loadConfig = (
  env: EnvSource,
  fileValues: Record<string, string> = {},
): BastionConfig => {
  const merged: Record<string, string> = { ...fileValues };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  const result = envSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return toConfig(result.data);
};
