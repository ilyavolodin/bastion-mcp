import { z } from 'zod';
import { authz, defineMutation, type RouteDefinition } from '../framework/route';
import { changeOwnPassword } from '../services/account';

const TAG = 'Session and self';

export const accountRoutes: RouteDefinition[] = [
  defineMutation({
    method: 'POST',
    url: '/me/password',
    tag: TAG,
    summary: 'Change your own local password',
    schema: {
      body: z.object({
        currentPassword: z.string().min(1).max(256),
        newPassword: z.string().min(1).max(512),
      }),
      response: z.object({ changed: z.literal(true) }),
    },
    authz: authz.self(),
    status: 200,
    handler: (ctx) => changeOwnPassword(ctx, ctx.body, ctx.req.headers.cookie),
  }),
];
