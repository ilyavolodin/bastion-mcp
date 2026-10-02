import type { ResourceData } from '@bastion-mcp/policy';
import { NotFoundApiError } from '../errors';
import type { AuthzInput, ResourceChoice } from '../framework/route';
import type { ApiDeps } from '../ports';
import type { StatsQuery } from '../ports/observability';
import { loadUserResource, orgResource, teamResource } from './resources';

/** The user as a `User` resource; `null` when no such user exists. */
export const userResourceFor = (
  input: Pick<AuthzInput, 'deps'>,
  userId: string,
): Promise<ResourceData | null> => loadUserResource(input.deps, userId);

/**
 * `GET /calls`: `?team=` is authorized on that team, `?user=` on that user, otherwise on the org (15.5).
 * Both filters together ask for an intersection nobody is scoped to, so they need the org rule.
 */
export const callsChoice = async (input: AuthzInput): Promise<ResourceChoice> => {
  const { team, user } = input.query;
  if (team && !user) return { rule: 'logs.team', resource: teamResource(team) };
  if (user && !team) {
    const resource = await userResourceFor(input, user);
    return { rule: 'logs.user', resource: resource ?? orgResource() };
  }
  return { rule: 'logs.org', resource: orgResource() };
};

/** `GET /calls/{id}`: the call's owner decides; unknown ids fall back to the org check (no existence oracle). */
export const callChoice = async (input: AuthzInput): Promise<ResourceChoice> => {
  const call = await input.deps.observability.calls.get(input.params.id ?? '');
  if (!call?.userId) return { rule: 'logs.org', resource: orgResource() };
  const resource = await userResourceFor(input, call.userId);
  return { rule: 'logs.user', resource: resource ?? orgResource() };
};

/** `GET /stats/calls?team=` is team-scoped; every other statistic is org-wide. */
export const callStatsChoice = (input: AuthzInput): ResourceChoice =>
  input.query.team
    ? { rule: 'logs.team', resource: teamResource(input.query.team) }
    : { rule: 'logs.org', resource: orgResource() };

export const getCall = async (deps: ApiDeps, id: string) => {
  const call = await deps.observability.calls.get(id);
  if (!call) throw new NotFoundApiError('call');
  return call;
};

export type StatsKind = 'callStats' | 'latency' | 'guardStats' | 'sandboxStats';

export const stats = (deps: ApiDeps, kind: StatsKind, query: StatsQuery) =>
  deps.observability.calls[kind](query);
