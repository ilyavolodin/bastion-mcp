import type { ActorName } from '../helpers/world';

export type Req = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, string>;
  body?: unknown;
};

/**
 * One row of the table-driven authorization test (23.3). `rule` is an id of `ROUTE_ACTIONS` and `route` one
 * expanded entry of that rule (`GET /teams/{id}`); the test checks that every table route has a case.
 *
 * `request(scope, actor)` builds a concrete request. `own` means the targeted resource is in the actor's
 * scope (team A for `managerOwn` and `service`, the member's own resource for `member`); `other` means it is
 * not (team A for `managerOther`, member B's or team B's resource for `member`). Allowed callers must get any
 * status except 401 and 403 (a 400 or 404 after authorization is fine); denied callers must get 403.
 */
export type AuthzCase = {
  rule: string;
  route: string;
  /**
   * Status expected instead of 403 when the grant is `scoped` and the scope is `other`: routes that filter
   * (lists answer 200 with fewer items) or hide (store answers 404) rather than deny.
   */
  scopedDeny?: number;
  request: (scope: 'own' | 'other', actor: ActorName) => Req;
};
