import type { EventBus, VersionTestStep } from '@bastion-mcp/api';
import type { GuardService } from '../contracts';
import type { Infra } from '../infra';
import type { UpstreamAccess } from './upstream-access';

export type StepOutcome = {
  status: VersionTestStep['status'];
  detail?: string;
  connectUrl?: string;
};

/** Records one step of a run: marks it running, persists, runs `fn`, records the outcome. False when it failed. */
export type StepRunner = (id: string, fn: () => Promise<StepOutcome>) => Promise<boolean>;

export type CatalogRow = {
  id: string;
  slug: string;
  kind: string;
  displayName: string;
};

export type VersionTestDeps = {
  access: UpstreamAccess;
  guards: Pick<GuardService, 'pipeline' | 'profiles'>;
  events: EventBus;
  /** `fetch` for the OSV queries; defaults to the server's outbound fetch. */
  fetch?: typeof fetch;
};

/** What the step modules need from the composition root. */
export type TestEnv = { infra: Infra; deps: VersionTestDeps };
