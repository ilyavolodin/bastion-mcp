import Fastify from 'fastify';
import { registerApi } from './app';
import type { ApiDeps } from './ports';

/** Handlers never run while the document is generated, so any dependency access is a bug. */
const unusable = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `ApiDeps.${String(prop)} is not available while generating the OpenAPI document`,
      );
    },
  },
);

/** Builds the OpenAPI 3.1 document without any infrastructure (used by the client generator). */
export const buildOpenApiDocument = async (
  baseUrl = 'https://bastion.example.com',
): Promise<unknown> => {
  const app = Fastify({ logger: false });
  const deps = { config: { baseUrl }, ...unusable } as unknown as ApiDeps;
  await registerApi(app, deps);
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  await app.close();
  return JSON.parse(response.body);
};
