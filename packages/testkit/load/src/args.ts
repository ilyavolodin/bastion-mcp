import { parseArgs } from 'node:util';
import { getScenario, type ScenarioDef } from './scenarios';

/** Parsed and validated configuration of one generator run. Pure: no I/O. */
export type RunConfig = {
  scenario: ScenarioDef;
  /** Bastion MCP URL the load goes through, for example https://bastion.test/mcp/i/echo. */
  url: string;
  /** Direct URL of the same upstream, for the baseline series (added latency). */
  directUrl: string | undefined;
  /** Pod-addressable URLs for forwarded-calls. */
  ownerUrl: string | undefined;
  nonOwnerUrl: string | undefined;
  /** Extra worker URLs the listen scenario spreads streams over (defaults to `url`). */
  streamUrls: string[];
  token: string;
  tool: string;
  toolArguments: Record<string, unknown>;
  rate: number;
  durationSec: number;
  streams: number;
  iterations: number;
  /** Skip the direct-to-upstream baseline (chaos and upgrade traffic; the result then cannot pass `check`). */
  skipBaseline: boolean;
  /** cold-start: slug template with {i}, appended to the base of `url` (…/mcp/i/). */
  coldSlugTemplate: string;
  connections: number;
  maxInflight: number;
  out: string;
};

const positiveInt = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`--${name} must be a positive integer, got "${raw}"`);
  return n;
};

const parseJsonObject = (raw: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`--args is not valid JSON: ${raw}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('--args must be a JSON object');
  }
  return value as Record<string, unknown>;
};

const requireUrl = (name: string, raw: string | undefined): string => {
  if (!raw) throw new Error(`--${name} is required`);
  try {
    new URL(raw);
  } catch {
    throw new Error(`--${name} is not a URL: ${raw}`);
  }
  return raw;
};

export const parseRunConfig = (
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): RunConfig => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      scenario: { type: 'string' },
      url: { type: 'string' },
      'direct-url': { type: 'string' },
      'owner-url': { type: 'string' },
      'non-owner-url': { type: 'string' },
      'stream-url': { type: 'string', multiple: true },
      token: { type: 'string' },
      tool: { type: 'string' },
      args: { type: 'string' },
      rate: { type: 'string' },
      duration: { type: 'string' },
      streams: { type: 'string' },
      iterations: { type: 'string' },
      'cold-slug-template': { type: 'string' },
      'skip-baseline': { type: 'boolean' },
      connections: { type: 'string' },
      'max-inflight': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  if (!values.scenario) throw new Error('--scenario is required');
  const scenario = getScenario(values.scenario);
  const token = values.token ?? env.BASTION_LOAD_TOKEN;
  if (!token)
    throw new Error('--token or BASTION_LOAD_TOKEN is required (a PAT for the load user)');

  const needsOwners = scenario.id === 'forwarded-calls';
  const url = needsOwners ? (values.url ?? values['owner-url']) : values.url;
  const config: RunConfig = {
    scenario,
    url: requireUrl('url', url),
    directUrl: values['direct-url'] ? requireUrl('direct-url', values['direct-url']) : undefined,
    ownerUrl: values['owner-url'] ? requireUrl('owner-url', values['owner-url']) : undefined,
    nonOwnerUrl: values['non-owner-url']
      ? requireUrl('non-owner-url', values['non-owner-url'])
      : undefined,
    streamUrls: (values['stream-url'] ?? []).map((u) => requireUrl('stream-url', u)),
    token,
    tool: values.tool ?? 'echo',
    toolArguments: values.args ? parseJsonObject(values.args) : { text: 'load' },
    rate: positiveInt('rate', values.rate, scenario.defaults.rate ?? 1),
    durationSec: positiveInt('duration', values.duration, scenario.defaults.durationSec),
    streams: positiveInt('streams', values.streams, scenario.defaults.streams ?? 1),
    iterations: positiveInt('iterations', values.iterations, scenario.defaults.iterations ?? 1),
    skipBaseline: values['skip-baseline'] === true,
    coldSlugTemplate: values['cold-slug-template'] ?? 'cold-{i}',
    connections: positiveInt('connections', values.connections, 16),
    maxInflight: positiveInt('max-inflight', values['max-inflight'], 4000),
    out: values.out ?? `results/${scenario.id}.json`,
  };
  if (needsOwners && (!config.ownerUrl || !config.nonOwnerUrl)) {
    throw new Error(
      'forwarded-calls needs --owner-url and --non-owner-url (pod-addressable worker URLs)',
    );
  }
  if (
    (scenario.id === 'call-guards-off' || scenario.id === 'call-guards-default') &&
    !config.directUrl &&
    !config.skipBaseline
  ) {
    throw new Error(
      `${scenario.id} needs --direct-url (the upstream called directly) to compute added latency, or --skip-baseline for traffic-only runs`,
    );
  }
  return config;
};

/** `…/mcp/i/echo` -> `…/mcp/i/` so cold-start can address one installation per iteration. */
export const coldStartUrl = (baseUrl: string, template: string, index: number): string => {
  const slug = template.replaceAll('{i}', String(index));
  const trimmed = baseUrl.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/mcp/i/');
  if (cut < 0) throw new Error(`--url must contain /mcp/i/<slug> for cold-start, got ${baseUrl}`);
  return `${trimmed.slice(0, cut)}/mcp/i/${slug}`;
};
