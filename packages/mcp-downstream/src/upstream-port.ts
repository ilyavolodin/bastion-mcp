/** Adapts the upstream runtime of `mcp-upstream` to the `UpstreamPort` the operations use (6.4, 6.6). */
import type {
  CallPrincipal,
  InstallationRegistry,
  ResolvedCredential,
  ResolvedInstallation,
  UpstreamCredentialProvider,
  UpstreamRuntime,
} from '@bastion-mcp/mcp-upstream';
import type { UpstreamPort } from './ports';

export const upstreamPortFrom = (
  runtime: Pick<UpstreamRuntime, 'service' | 'listen'>,
  deps: {
    installations: Pick<InstallationRegistry, 'get'>;
    credentials: UpstreamCredentialProvider;
  },
): UpstreamPort => {
  const resolve = async (
    installationId: string,
    principal: CallPrincipal,
  ): Promise<
    { installation: ResolvedInstallation; credential: ResolvedCredential } | undefined
  > => {
    const installation = await deps.installations.get(installationId);
    if (!installation) return undefined;
    const credential = await deps.credentials.resolve(principal, installation, installation.spec);
    return { installation, credential };
  };
  return {
    execute: (request) => runtime.service.execute(request),
    executeTask: (request) => runtime.service.executeTask(request),
    async subscribeResource(args) {
      const target = await resolve(args.installationId, args.principal);
      if (!target) return;
      await runtime.listen.subscribeResource(
        {
          ...target,
          principal: args.principal,
          downstreamUri: args.downstreamUri,
          endpointId: args.endpointId,
        },
        args.signal,
      );
    },
    async unsubscribeResource(args) {
      const target = await resolve(args.installationId, args.principal);
      if (!target) return;
      await runtime.listen.unsubscribeResource(
        {
          ...target,
          principal: args.principal,
          downstreamUri: args.downstreamUri,
          endpointId: args.endpointId,
        },
        args.signal,
      );
    },
    async joinListen(args) {
      const target = await resolve(args.installationId, args.principal);
      if (target) await runtime.listen.join({ ...target, principal: args.principal });
    },
    async leaveListen(args) {
      const target = await resolve(args.installationId, args.principal);
      if (target) await runtime.listen.leave({ ...target, principal: args.principal });
    },
  };
};
