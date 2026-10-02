/** Runner state machine (8.3): unbound -> bound -> running -> bound. Pure. */

export type RunnerState = 'unbound' | 'bound' | 'running';
export type RunnerEvent = 'bind' | 'start' | 'stopped';

export type Transition = { ok: true; state: RunnerState } | { ok: false; reason: string };

/** `stopped` covers both `/v1/stop` and the server process exiting; it returns to `bound`. */
export const transition = (state: RunnerState, event: RunnerEvent): Transition => {
  switch (event) {
    case 'bind':
      return state === 'unbound'
        ? { ok: true, state: 'bound' }
        : { ok: false, reason: 'runner is already bound' };
    case 'start':
      return state === 'bound'
        ? { ok: true, state: 'running' }
        : { ok: false, reason: state === 'unbound' ? 'runner is not bound' : 'already running' };
    case 'stopped':
      return state === 'running'
        ? { ok: true, state: 'bound' }
        : { ok: false, reason: 'runner is not running' };
  }
};

export type Endpoint = { method: string; path: string };

/** The state each endpoint requires (8.3 table); `any` endpoints are always served. */
export const requiredState = (endpoint: Endpoint): RunnerState | 'any' | null => {
  const key = `${endpoint.method} ${endpoint.path}`;
  switch (key) {
    case 'GET /healthz':
      return 'any';
    case 'POST /v1/bind':
      return 'unbound';
    case 'POST /v1/start':
      return 'bound';
    case 'GET /v1/stdio':
    case 'POST /v1/stop':
      return 'running';
    default:
      return null;
  }
};

export type Decision = { allow: true } | { allow: false; status: 401 | 404 | 409; reason: string };

/**
 * Decides one request: `/healthz` is open; `/v1/bind` is open while unbound; everything else needs the
 * token (`authorized`) once bound, and the right state.
 */
export const decideRequest = (
  state: RunnerState,
  endpoint: Endpoint,
  authorized: boolean,
): Decision => {
  const required = requiredState(endpoint);
  if (required === null) return { allow: false, status: 404, reason: 'not found' };
  if (required === 'any') return { allow: true };
  if (state !== 'unbound' && !authorized) {
    return { allow: false, status: 401, reason: 'missing or invalid bearer token' };
  }
  if (required === 'unbound') {
    return state === 'unbound'
      ? { allow: true }
      : { allow: false, status: 409, reason: 'runner is already bound' };
  }
  if (state === 'unbound') return { allow: false, status: 409, reason: 'runner is not bound' };
  return state === required
    ? { allow: true }
    : { allow: false, status: 409, reason: `runner state is ${state}, ${required} required` };
};
