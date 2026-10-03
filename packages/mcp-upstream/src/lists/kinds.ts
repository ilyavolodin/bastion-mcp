/**
 * The four list kinds of MCP, in one table: the method that lists them and the key that method uses both in its
 * result and in `UpstreamItems`.
 */
export const LIST_ITEM_KEY = {
  'tools/list': 'tools',
  'prompts/list': 'prompts',
  'resources/list': 'resources',
  'resources/templates/list': 'resourceTemplates',
} as const;

export type ListMethod = keyof typeof LIST_ITEM_KEY;
export type ListItemKey = (typeof LIST_ITEM_KEY)[ListMethod];

export const LIST_METHODS: readonly ListMethod[] = Object.keys(LIST_ITEM_KEY) as ListMethod[];

/** The smallest of the values that are numbers; `undefined` when there are none. Pure. */
export const minDefined = (values: ReadonlyArray<number | undefined>): number | undefined => {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
};
