import { z } from 'zod';
import { authz, defineStream, type RouteDefinition } from '../framework/route';
import { EVENT_TYPES, eventsSource } from '../services/events';

const typesQuery = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(EVENT_TYPES as [string, ...string[]])).min(1));

export const eventsRoutes: RouteDefinition[] = [
  defineStream({
    url: '/events',
    tag: 'Session and self',
    summary: 'Server-Sent Events: notifications, installation status, test progress, drift reviews',
    schema: {
      query: z.object({
        types: typesQuery.optional(),
        topic: z.string().min(1).max(256).optional(),
      }),
    },
    authz: authz.self(),
    handler: (ctx) =>
      eventsSource(ctx.deps, ctx.principal, {
        types: ctx.query.types as readonly (typeof EVENT_TYPES)[number][] | undefined,
        topic: ctx.query.topic,
      }),
  }),
];
