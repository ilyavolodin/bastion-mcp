/** `completion/complete` (6.3): routed by the prompt name or the template URI in `ref`. */

import { PolicyDeniedError } from '@bastion-mcp/core';
import { SPAN_ATTRS } from '@bastion-mcp/mcp-upstream';
import { ResourceNotFoundError, resolveResourceUri } from '@bastion-mcp/router';
import { SPAN_NAMES } from '@bastion-mcp/telemetry';
import { InvalidParamsError, UnknownItemError } from '../rpc';
import type { JsonObject, OpContext, Operation, OpOutcome } from '../types';
import type { OperationDeps } from './deps';
import { runRoutedOperation } from './outcome';
import {
  callPrincipalOf,
  installationDataOf,
  isRecord,
  policyContextOf,
  upstreamContextOf,
  withSpan,
} from './support';

export const createCompletion = (deps: OperationDeps): Operation => ({
  method: 'completion/complete',
  async run(params: JsonObject, ctx: OpContext): Promise<OpOutcome<JsonObject>> {
    const ref = params.ref;
    if (!isRecord(ref) || typeof ref.type !== 'string')
      throw new InvalidParamsError('ref is required');
    let installationId: string | undefined;
    let upstreamRef: JsonObject;
    let resource: { type: 'Prompt'; name: string } | { type: 'Resource'; uri: string };
    if (ref.type === 'ref/prompt' && typeof ref.name === 'string') {
      const route = ctx.endpoint.promptRoutes.get(ref.name);
      if (!route) throw new UnknownItemError('prompt', ref.name);
      installationId = route.installationId;
      upstreamRef = { ...ref, name: route.upstreamName };
      resource = { type: 'Prompt', name: ref.name };
    } else if (ref.type === 'ref/resource' && typeof ref.uri === 'string') {
      const template = ctx.endpoint.uriIndex.templates.find((t) => t.advertised === ref.uri);
      if (template) {
        installationId = template.installationId;
        upstreamRef = {
          ...ref,
          uri: template.route.kind === 'template' ? template.route.upstreamTemplate : ref.uri,
        };
      } else {
        const resolved = resolveResourceUri(ctx.endpoint.uriIndex, ref.uri);
        if (!resolved.ok) throw new ResourceNotFoundError(ref.uri);
        installationId = resolved.target.installationId;
        upstreamRef = { ...ref, uri: resolved.target.upstreamUri };
      }
      resource = { type: 'Resource', uri: ref.uri };
    } else {
      throw new InvalidParamsError('unsupported ref');
    }
    const installation = ctx.resolved.installations.get(installationId);
    if (!installation) throw new UnknownItemError('prompt', String(ref.name ?? ref.uri));
    const itemName = resource.type === 'Prompt' ? resource.name : resource.uri;
    return runRoutedOperation(
      deps,
      ctx,
      'completion/complete',
      installation,
      async (record) => {
        const profile = deps.profiles ? await deps.profiles.profile(ctx.principal) : {};
        const decision = await withSpan(
          deps,
          SPAN_NAMES.policy,
          { [SPAN_ATTRS.policyAction]: 'complete' },
          async () =>
            deps.policy.current().authorize({
              principal: deps.toPolicyPrincipal(ctx.principal, profile),
              action: 'complete',
              resource: { ...resource, installation: installationDataOf(installation) },
              context: policyContextOf(ctx, deps.clock.now()),
            }),
        );
        record.policyReasons = decision.reasons;
        if (decision.decision === 'deny') {
          throw new PolicyDeniedError('You are not allowed to request completions here.', {
            reason: 'denied by policy',
            policyIds: decision.reasons,
          });
        }
        const principal = await callPrincipalOf(deps, ctx);
        const outcome = await deps.upstream.execute({
          installationId: installation.id,
          method: 'completion/complete',
          params: { ...params, ref: upstreamRef },
          ctx: upstreamContextOf(ctx, principal, installation.id, {
            downstreamName: record.itemName,
          }),
        });
        if (outcome.kind !== 'complete')
          throw new InvalidParamsError('completion cannot ask for input');
        const result = isRecord(outcome.result) ? outcome.result : {};
        return { kind: 'complete', result };
      },
      { itemName },
    );
  },
});
