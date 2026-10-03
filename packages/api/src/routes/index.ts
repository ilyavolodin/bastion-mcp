import type { RouteDefinition } from '../framework/route';
import { accountRoutes } from './account';
import { autoInstallRoutes, driftRoutes } from './auto-install';
import { catalogRoutes } from './catalog';
import { endpointsRoutes } from './endpoints';
import { eventsRoutes } from './events';
import { guardsRoutes } from './guards';
import { identityRoutes } from './identity';
import { installationsRoutes } from './installations';
import { limitsRoutes } from './limits';
import { marketplacesRoutes } from './marketplaces';
import { observabilityRoutes } from './observability';
import { overridesRoutes } from './overrides';
import { policiesRoutes } from './policies';
import { registryRoutes } from './registry';
import { secretsRoutes } from './secrets';
import { selfRoutes } from './self';
import { systemRoutes } from './system';
import { usersRoutes } from './users';

/** Every route of 17.2, grouped by area. */
export const ALL_ROUTES: readonly RouteDefinition[] = [
  ...selfRoutes,
  ...accountRoutes,
  ...usersRoutes,
  ...identityRoutes,
  ...catalogRoutes,
  ...installationsRoutes,
  ...endpointsRoutes,
  ...overridesRoutes,
  ...driftRoutes,
  ...autoInstallRoutes,
  ...registryRoutes,
  ...policiesRoutes,
  ...guardsRoutes,
  ...limitsRoutes,
  ...secretsRoutes,
  ...observabilityRoutes,
  ...systemRoutes,
  ...marketplacesRoutes,
  ...eventsRoutes,
];
