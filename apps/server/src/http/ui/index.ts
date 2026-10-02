import type { FastifyInstance } from 'fastify';
import type { AuthServices } from '../../contracts';
import type { Infra } from '../../infra';
import { registerPageAssets } from '../pages/assets';
import { registerConnectRoutes } from './connect';
import { type LoginOptions, registerLoginRoutes } from './login';
import { registerAuthorizationServer, registerInteractionPages } from './oauth';
import { registerScimRoutes } from './scim';

export type AuthRoutesOptions = { infra: Infra; auth: AuthServices } & LoginOptions;

/**
 * Registers the identity routes of the ui role (9.1 to 9.6): the authorization server and its pages, IdP and local
 * login, logout, `/connect`, the upstream OAuth callback and documents, and SCIM. Every route lives in its own
 * encapsulated plugin so content-type parsers never leak between them.
 */
export const registerAuthRoutes = async (
  app: FastifyInstance,
  { infra, auth, onProvisioned }: AuthRoutesOptions,
): Promise<void> => {
  const deps = { infra, auth };
  await registerPageAssets(app);
  await registerLoginRoutes(app, deps, onProvisioned ? { onProvisioned } : {});
  await registerInteractionPages(app, deps);
  await registerAuthorizationServer(app, deps);
  await registerConnectRoutes(app, deps);
  await registerScimRoutes(app, deps);
};
