import type { Principal } from '@bastion-mcp/auth';
import type { SseSource } from '../framework/route';
import type { ApiDeps, ApiEvent, ApiEventType } from '../ports';

export const EVENT_TYPES: readonly ApiEventType[] = [
  'notification',
  'installation.status',
  'test.progress',
  'drift.review',
  'installation.log',
];

/** An event reaches a user it names, members of a team it names, and admins and auditors for `org` (18.1). */
export const canReceive = (principal: Principal, event: ApiEvent): boolean => {
  const { audience } = event;
  if (audience.userIds?.includes(principal.id)) return true;
  if (audience.teamIds?.some((id) => principal.teams.some((t) => t.teamId === id))) return true;
  return (
    audience.org === true && (principal.orgRole === 'admin' || principal.orgRole === 'auditor')
  );
};

/** `GET /events`: fan-out through the `EventBus` with the caller's audience and optional filters. */
export const eventsSource = (
  deps: ApiDeps,
  principal: Principal,
  filter: { types?: readonly ApiEventType[] | undefined; topic?: string | undefined },
): SseSource => ({
  initial: [{ event: 'ready', data: { principalId: principal.id } }],
  subscribe: (emit) =>
    deps.events.subscribe((event) => {
      if (filter.types && !filter.types.includes(event.type)) return;
      if (filter.topic && event.topic !== filter.topic) return;
      if (!canReceive(principal, event)) return;
      emit({ event: event.type, id: event.id, data: event.data });
    }),
});
