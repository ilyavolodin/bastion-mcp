/** SCIM 2.0 at /scim/v2 (9.1): the service handles authentication, routing and error bodies. */
import { SCIM_CONTENT_TYPE } from '@bastion-mcp/auth';
import type { FastifyInstance } from 'fastify';
import type { UiDeps } from './util';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const registerScimRoutes = async (app: FastifyInstance, { auth }: UiDeps) => {
  await app.register(async (scope) => {
    const parse = (_req: unknown, body: unknown, done: (e: Error | null, v?: unknown) => void) => {
      const text = String(body);
      if (text.trim() === '') return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch {
        done(null, { __invalid: true });
      }
    };
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      ['application/scim+json', 'application/json'],
      { parseAs: 'string' },
      parse,
    );
    scope.addContentTypeParser('*', { parseAs: 'string' }, parse);

    const handler = async (
      req: Parameters<Parameters<typeof scope.route>[0]['handler']>[0],
      reply: Parameters<Parameters<typeof scope.route>[0]['handler']>[1],
    ) => {
      const url = new URL(req.raw.url ?? '/', 'http://internal');
      const path = url.pathname.slice('/scim/v2'.length) || '/';
      const query: Record<string, string | undefined> = {};
      for (const [k, v] of url.searchParams) query[k] = v;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(',') : v;
      }
      const response = await auth.scim.handle({
        method: req.method,
        path,
        query,
        headers,
        body: req.body,
      });
      reply.code(response.status);
      for (const [k, v] of Object.entries(response.headers)) reply.header(k, v);
      if (!reply.hasHeader('content-type')) reply.header('content-type', SCIM_CONTENT_TYPE);
      reply.header('cache-control', 'no-store');
      return reply.send(response.status === 204 ? undefined : JSON.stringify(response.body));
    };
    for (const url of ['/scim/v2', '/scim/v2/*'])
      scope.route({ method: [...METHODS], url, handler });
  });
};
