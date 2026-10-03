/** `resources/read` (6.3, 7.4): URI index routing, prefix stripping, Bastion-hosted `skill://` resources. */
import { extractResourceContents, extractUriSegments } from '@bastion-mcp/guards';
import { addedResourceContents, addedTemplateContents } from '@bastion-mcp/overrides';
import { ResourceNotFoundError, resolveResourceUriWithSeen } from '@bastion-mcp/router';
import { trace } from '@opentelemetry/api';
import { CallRecord } from '../observability/call-log';
import { InvalidParamsError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { recordOperationOutcome } from './outcome';
import { runRouted } from './routed';
import { installationDataOf, retryParts } from './support';

const SKILL_SCHEME = 'skill://';
const DEFAULT_READ_TTL_MS = 60_000;

export const createResourcesRead = (deps: OperationDeps): Operation => ({
  method: 'resources/read',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const uri = params.uri;
    if (typeof uri !== 'string' || uri === '') throw new InvalidParamsError('uri is required');
    const retry = retryParts(params);
    if (deps.skills && uri.startsWith(SKILL_SCHEME)) {
      const skill = await deps.skills.readResource(ctx.principal, uri);
      if (!skill) throw new ResourceNotFoundError(uri);
      return {
        kind: 'complete',
        result: { ...skill, ttlMs: ctx.endpoint.ttlMs, cacheScope: 'private' },
      };
    }
    const target = await resolveResourceUriWithSeen(ctx.endpoint.uriIndex, uri, {
      store: deps.seenUris,
      principalId: ctx.principal.id,
      endpointId: ctx.endpoint.endpointId,
    });
    if (!target.ok) throw new ResourceNotFoundError(uri);
    const installation = ctx.resolved.installations.get(target.target.installationId);
    if (!installation) throw new ResourceNotFoundError(uri);
    const upstreamUri = target.target.upstreamUri;
    const hosted = target.target.hosted;
    const record = new CallRecord('resources/read', deps.clock.now());
    const span = trace.getActiveSpan()?.spanContext() ?? ctx.trace;
    try {
      const outcome = await runRouted(
        deps,
        ctx,
        {
          method: 'resources/read',
          installation,
          downstreamName: uri,
          upstreamName: upstreamUri,
          item: { kind: 'resource', name: uri },
          policy: {
            action: 'readResource',
            resource: { type: 'Resource', installation: installationDataOf(installation), uri },
          },
          request: {
            root: { uri: upstreamUri },
            segments: extractUriSegments(upstreamUri),
            rebuild: (guarded) => ({ uri: guarded.uri }),
            bindArgs: (p) => p.uri ?? '',
          },
          responseSegments: (result) => extractResourceContents(result.contents),
          ...(hosted
            ? {
                local: () => {
                  const served =
                    hosted.kind === 'resource'
                      ? addedResourceContents(uri, hosted.def)
                      : addedTemplateContents(hosted.uriTemplate, hosted.def, upstreamUri);
                  if (!served) throw new ResourceNotFoundError(uri);
                  return { contents: served.contents.map((c) => ({ ...c, uri })) };
                },
              }
            : { readKey: upstreamUri }),
        },
        retry,
        record,
      );
      if (outcome.kind === 'complete') {
        const result = outcome.result;
        // Bastion always answers private; the TTL is the upstream's when it gave one (6.7).
        return {
          kind: 'complete',
          result: {
            ...result,
            ttlMs: typeof result.ttlMs === 'number' ? result.ttlMs : DEFAULT_READ_TTL_MS,
            cacheScope: 'private',
          },
        };
      }
      return outcome;
    } catch (error) {
      record.fail(error);
      throw error;
    } finally {
      recordOperationOutcome(deps, ctx, record, span, installation, 'resources/read');
    }
  },
});
