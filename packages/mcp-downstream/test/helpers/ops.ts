import { BastionError, type Keyring, newId, wrapRequestState } from '@bastion-mcp/core';
import { createGuardRegistry, GuardPipeline, type ProfileLayers } from '@bastion-mcp/guards';
import { EngineLimiter, MemoryBackend, type Rule } from '@bastion-mcp/limits';
import type { UpstreamOutcome } from '@bastion-mcp/mcp-upstream';
import { InMemorySeenUriStore, type EndpointPolicy } from '@bastion-mcp/router';
import { type CallLogRow, createMetrics } from '@bastion-mcp/telemetry';
import { metrics as otelMetrics, trace } from '@opentelemetry/api';
import { createOperations, createOpRunner } from '../../src/operations/registry';
import {
  defaultToPolicyPrincipal,
  type OperationDeps,
  DEFAULT_SETTINGS,
} from '../../src/operations/deps';
import type {
  GuardProfilePort,
  LimitRulesPort,
  PrincipalProfilePort,
  ResourceSubscription,
  SkillsProvider,
  UpstreamPort,
} from '../../src/ports';
import { noopLogger, systemClock } from '../../src/ports';
import type { OpContext } from '../../src/types';
import { allowAllPolicy } from './fixtures';

export const keyring: Keyring = { activeKid: 'k1', keys: new Map([['k1', Buffer.alloc(32, 9)]]) };

type Upstream = Parameters<UpstreamPort['execute']>[0];
export type UpstreamCall = Upstream & { at: number };

/** A scriptable upstream: `script` answers each call; every call is recorded. */
export class FakeUpstream implements UpstreamPort {
  readonly calls: UpstreamCall[] = [];
  readonly taskCalls: Parameters<UpstreamPort['executeTask']>[0][] = [];
  readonly subscriptions: { action: 'add' | 'remove'; args: ResourceSubscription }[] = [];
  script: (call: Upstream) => UpstreamOutcome | Promise<UpstreamOutcome> = () => ({
    kind: 'complete',
    result: { content: [{ type: 'text', text: 'ok' }] },
  });
  taskScript: (call: Parameters<UpstreamPort['executeTask']>[0]) => UpstreamOutcome | Promise<UpstreamOutcome> = () => ({
    kind: 'complete',
    result: { taskId: 'x', status: 'working' },
  });

  async execute(request: Upstream): Promise<UpstreamOutcome> {
    this.calls.push({ ...request, at: Date.now() });
    return this.script(request);
  }
  async executeTask(request: Parameters<UpstreamPort['executeTask']>[0]): Promise<UpstreamOutcome> {
    this.taskCalls.push(request);
    return this.taskScript(request);
  }
  async subscribeResource(args: ResourceSubscription): Promise<void> {
    this.subscriptions.push({ action: 'add', args });
  }
  async unsubscribeResource(args: ResourceSubscription): Promise<void> {
    this.subscriptions.push({ action: 'remove', args });
  }
  async joinListen(): Promise<void> {}
  async leaveListen(): Promise<void> {}
}

/** Wraps a state the way the upstream service does, so fakes can return realistic `input_required` outcomes. */
export const wrappedState = (
  ctx: OpContext,
  installationId: string,
  method: string,
  name: string,
  args: unknown,
  upstreamState?: string,
): string =>
  wrapRequestState(
    keyring,
    {
      principalId: ctx.principal.id,
      endpointId: ctx.endpoint.endpointId,
      installationId,
      method,
      name,
      args,
    },
    { now: Math.floor(Date.now() / 1000), ...(upstreamState === undefined ? {} : { upstreamState }) },
  );

export type OpsHarness = {
  deps: OperationDeps;
  upstream: FakeUpstream;
  rows: CallLogRow[];
  run: ReturnType<typeof createOpRunner>;
  registry: ReturnType<typeof createOperations>;
  seen: InMemorySeenUriStore;
};

export const makeOps = (
  options: {
    policy?: EndpointPolicy | undefined;
    guardLayers?: ProfileLayers | undefined;
    rules?: readonly Rule[] | undefined;
    skills?: SkillsProvider | undefined;
    profiles?: PrincipalProfilePort | undefined;
    installations?: OperationDeps['installations'] | undefined;
    reads?: OperationDeps['reads'] | undefined;
    settings?: Partial<OperationDeps['settings']> | undefined;
  } = {},
): OpsHarness => {
  const upstream = new FakeUpstream();
  const rows: CallLogRow[] = [];
  const seen = new InMemorySeenUriStore();
  const guardProfiles: GuardProfilePort = { layersFor: () => options.guardLayers ?? {} };
  const limitRules: LimitRulesPort = { rulesFor: () => options.rules ?? [] };
  const deps: OperationDeps = {
    upstream,
    stateKeyring: keyring,
    policy: { current: () => options.policy ?? allowAllPolicy },
    toPolicyPrincipal: defaultToPolicyPrincipal,
    profiles: options.profiles,
    limiter: new EngineLimiter(new MemoryBackend(1)),
    limitRules,
    guards: new GuardPipeline({ guards: createGuardRegistry(), clock: systemClock }),
    guardProfiles,
    seenUris: seen,
    callLog: { append: (row) => void rows.push(row) },
    skills: options.skills,
    installations: options.installations ?? { get: async () => null },
    reads: options.reads,
    metrics: createMetrics(otelMetrics.getMeter('test')),
    tracer: trace.getTracer('test'),
    clock: systemClock,
    logger: noopLogger,
    newId,
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
  };
  const registry = createOperations(deps);
  return { deps, upstream, rows, run: createOpRunner(deps, registry), registry, seen };
};

export const isBastion = (e: unknown): e is BastionError => e instanceof BastionError;
