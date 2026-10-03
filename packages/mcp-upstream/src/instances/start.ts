import {
  type InstanceEvent,
  type InstanceStartPhase,
  type InstanceState,
  instanceStateMachine,
  type SandboxHandle,
} from '@bastion-mcp/sandbox';

/** Workspace of the one-off sandbox that captures a lockfile (8.7): nothing is kept. */
export const LOCKFILE_WORKSPACE_MIB = 256;

/** Where one sandbox start has got to, for the state machine and for failure reporting (8.6). */
export class StartProgress {
  state: InstanceState = { kind: 'absent' };
  phase: InstanceStartPhase = 'claiming';
  handle: SandboxHandle | undefined;

  constructor() {
    this.apply({ type: 'start' });
  }

  apply(event: InstanceEvent): void {
    const next = instanceStateMachine(this.state, event);
    if (next.ok) this.state = next.state;
  }

  /** Records the phase without a state-machine event (the runner's `ready` already moved the machine). */
  setPhase(phase: InstanceStartPhase): void {
    this.phase = phase;
  }

  /** Enters a start phase and feeds it to the state machine. */
  enter(phase: Exclude<InstanceStartPhase, 'claiming'>): void {
    this.phase = phase;
    this.apply({ type: 'phase', phase });
  }
}
