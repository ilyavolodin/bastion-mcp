import { CALL_OUTCOMES } from '@bastion-mcp/core';
import { z } from 'zod';
import { DEFAULT_LIMIT, listQuerySchema, MAX_LIMIT, pageSchema } from '../framework/conventions';
import { authz, defineRoute, type RouteDefinition, RouteReply } from '../framework/route';
import { idParams } from '../schemas/common';
import { callRecord, findingRecord, pageOf, untyped } from '../schemas/rows';
import { auditChoice, renderAuditExport } from '../services/audit';
import {
  callChoice,
  callStatsChoice,
  callsChoice,
  getCall,
  stats,
} from '../services/observability';
import { org } from './shared';

const TAG = 'Observability';
const AUDIT_TAG = 'Audit';

const range = {
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
};

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(1024).optional(),
};

const callsQuery = z.object({
  ...pageQuery,
  user: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  installation: z.string().min(1).optional(),
  item: z.string().min(1).optional(),
  outcome: z.enum(CALL_OUTCOMES).optional(),
  ...range,
});

const _callSchema = z.looseObject({
  id: z.string(),
  ts: z.string(),
  userId: z.string().nullable(),
});

const statsQuery = z.object({
  groupBy: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
    .optional(),
  bucket: z.enum(['minute', 'hour', 'day']).optional(),
  team: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  ...range,
});

const seriesSchema = z.object({
  buckets: z.array(
    z.object({
      ts: z.string(),
      group: z.string().nullable(),
      values: z.record(z.string(), z.number()),
    }),
  ),
});

const auditEventSchema = z.looseObject({
  seq: z.string(),
  id: z.string(),
  ts: z.string(),
  action: z.string(),
});

const statRoute = (
  url: string,
  summary: string,
  kind: 'callStats' | 'latency' | 'guardStats' | 'sandboxStats',
  team: boolean,
): RouteDefinition =>
  defineRoute({
    method: 'GET',
    url,
    tag: TAG,
    summary,
    schema: { query: statsQuery, response: seriesSchema },
    authz: team
      ? authz.oneOf(['logs.org', 'logs.team', 'logs.user'], callStatsChoice)
      : authz.on('logs.org', org),
    handler: (ctx) =>
      stats(ctx.deps, kind, {
        groupBy: ctx.query.groupBy,
        bucket: ctx.query.bucket,
        from: ctx.query.from,
        to: ctx.query.to,
        teamId: team ? ctx.query.team : undefined,
        userId: team ? ctx.query.user : undefined,
      }),
  });

export const observabilityRoutes: RouteDefinition[] = [
  defineRoute({
    method: 'GET',
    url: '/calls',
    tag: TAG,
    summary: 'Call log with filters (user, team, installation, item, outcome, time range)',
    schema: { query: callsQuery, response: untyped(pageOf('CallRecordPage', callRecord)) },
    authz: authz.oneOf(['logs.org', 'logs.team', 'logs.user'], callsChoice),
    handler: (ctx) =>
      ctx.deps.observability.calls.list({
        limit: ctx.query.limit,
        cursor: ctx.query.cursor,
        userId: ctx.query.user,
        teamId: ctx.query.team,
        installationId: ctx.query.installation,
        item: ctx.query.item,
        outcome: ctx.query.outcome,
        from: ctx.query.from,
        to: ctx.query.to,
      }),
  }),
  defineRoute({
    method: 'GET',
    url: '/calls/{id}',
    tag: TAG,
    summary: 'One call',
    schema: { params: idParams, response: untyped(callRecord) },
    authz: authz.oneOf(['logs.org', 'logs.user'], callChoice),
    handler: (ctx) => getCall(ctx.deps, ctx.params.id),
  }),
  statRoute('/stats/calls', 'Call counts from the rollups', 'callStats', true),
  statRoute('/stats/latency', 'Latency percentiles', 'latency', false),
  statRoute('/stats/guards', 'Guard verdicts', 'guardStats', false),
  statRoute('/stats/sandboxes', 'Sandbox starts and usage', 'sandboxStats', false),
  defineRoute({
    method: 'GET',
    url: '/security/findings',
    tag: TAG,
    summary: 'Security findings (guards, drift, egress)',
    schema: {
      query: z.object({ ...pageQuery, ...range }),
      response: untyped(pageOf('FindingPage', findingRecord)),
    },
    authz: authz.on('logs.org', org),
    handler: (ctx) =>
      ctx.deps.observability.calls.findings({
        limit: ctx.query.limit,
        cursor: ctx.query.cursor,
        from: ctx.query.from,
        to: ctx.query.to,
      }),
  }),

  defineRoute({
    method: 'GET',
    url: '/audit',
    tag: AUDIT_TAG,
    summary: 'Audit events',
    schema: {
      query: listQuerySchema.omit({ q: true, sort: true }).extend({
        team: z.string().min(1).optional(),
        actor: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        ...range,
      }),
      response: pageSchema(auditEventSchema),
    },
    authz: authz.oneOf(['audit.org', 'audit.team'], auditChoice),
    handler: (ctx) =>
      ctx.deps.observability.audit.list({
        limit: ctx.query.limit,
        cursor: ctx.query.cursor,
        teamId: ctx.query.team,
        actorId: ctx.query.actor,
        action: ctx.query.action,
        from: ctx.query.from,
        to: ctx.query.to,
      }),
  }),
  defineRoute({
    method: 'GET',
    url: '/audit/export',
    tag: AUDIT_TAG,
    summary: 'Export the audit log as CSV or JSON',
    schema: {
      query: z.object({ format: z.enum(['csv', 'json']).default('csv'), ...range }),
      response: z.string(),
    },
    authz: authz.on('audit.org', org),
    handler: async (ctx) => {
      const out = await renderAuditExport(ctx.deps, ctx.query.format, ctx.query);
      return new RouteReply(out.body, {
        raw: true,
        headers: {
          'content-type': out.contentType,
          'content-disposition': `attachment; filename="${out.filename}"`,
          'cache-control': 'no-store',
        },
      });
    },
  }),
  defineRoute({
    method: 'GET',
    url: '/audit/verify',
    tag: AUDIT_TAG,
    summary: 'Verify the audit hash chain',
    schema: {
      response: z.union([
        z.object({ ok: z.literal(true), checked: z.number() }),
        z.object({ ok: z.literal(false), checked: z.number(), brokenAtSeq: z.string() }),
      ]),
    },
    authz: authz.on('audit.org', org),
    handler: (ctx) => ctx.deps.observability.audit.verify(),
  }),
];
