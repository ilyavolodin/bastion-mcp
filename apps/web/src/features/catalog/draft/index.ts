/**
 * The catalog editor's form state and the pure functions that turn it into API bodies, in four modules: `types`
 * (the draft and its defaults), `secrets` (templates, secret names and the helpers that add credential rows),
 * `validate` (constraints and the reasons a draft cannot be saved) and `serialize` (draft to API bodies and back).
 */

export { slugify } from '@bastion-mcp/core/ids';
export * from './secrets';
export * from './serialize';
export * from './types';
export * from './validate';
