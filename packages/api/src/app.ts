import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { installProblemHandlers, registerRoutes } from './framework/register';
import type { RouteDefinition } from './framework/route';
import { decorateOpenApi, type OpenApiDoc, openApiInfo, SECURITY_SCHEMES } from './openapi';
import type { ApiDeps } from './ports';
import { ALL_ROUTES } from './routes';

export const API_PREFIX = '/api/v1';

export type RegisterOptions = {
  /** Route set to serve (defaults to every route of 17.2); tests narrow it. */
  routes?: readonly RouteDefinition[];
};

/**
 * Registers the control-plane REST API under `/api/v1` (17). Zod route schemas are the single source for
 * validation and the OpenAPI 3.1 document at `/api/v1/openapi.json`. Throws at startup when a route lacks a
 * Cedar authorization declaration.
 */
export const registerApi = async (
  app: FastifyInstance,
  deps: ApiDeps,
  options: RegisterOptions = {},
): Promise<void> => {
  await app.register(
    async (api) => {
      api.setValidatorCompiler(validatorCompiler);
      api.setSerializerCompiler(serializerCompiler);
      await api.register(swagger, {
        openapi: {
          openapi: '3.1.0',
          info: openApiInfo,
          components: { securitySchemes: SECURITY_SCHEMES },
          servers: [{ url: deps.config.baseUrl + API_PREFIX }],
        },
        transform: jsonSchemaTransform,
        transformObject: (input) =>
          'openapiObject' in input
            ? decorateOpenApi(input.openapiObject as unknown as OpenApiDoc)
            : input.swaggerObject,
      });
      installProblemHandlers(api);
      registerRoutes(api, deps, options.routes ?? ALL_ROUTES);
      api.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) =>
        reply.type('application/json').send(api.swagger()),
      );
    },
    { prefix: API_PREFIX },
  );
};
