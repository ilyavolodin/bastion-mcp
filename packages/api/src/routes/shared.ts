import type { ResourceData } from '@bastion-mcp/policy';
import type { ApiDeps } from '../ports';
import type { Collection } from '../ports/store';

export const ORG_RESOURCE_DATA: ResourceData = { type: 'Org' };

/** `() => Org`, for authorization rules that act on the organization. */
export const org = (): ResourceData => ORG_RESOURCE_DATA;

/** `If-Match` loader: the `updatedAt` of the row addressed by a path parameter (17.1). */
export const versionOf =
  (collection: Collection, key = 'id') =>
  async (input: { deps: ApiDeps; params: Record<string, string> }): Promise<string | null> => {
    const id = input.params[key];
    if (id === undefined) return null;
    return (await input.deps.store.get(collection, id))?.updatedAt ?? null;
  };

/** The Team addressed by a path parameter (default `id`). */
export const teamOf =
  (key = 'id') =>
  (input: { params: Record<string, string> }): ResourceData => ({
    type: 'Team',
    id: input.params[key] ?? '',
  });
