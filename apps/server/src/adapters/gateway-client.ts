/**
 * The ui role as a client of the gateway's own public endpoints.
 *
 * Only workers touch MCP traffic and sandboxes (4.1), and the internal RPC (21.2) forwards calls to the owner of a
 * stateful instance; it has no route that starts a modern remote session on behalf of another process. A `ui`-only
 * process therefore does what any MCP client does: it connects to `/mcp/i/{slug}` through the public URL (the ingress
 * sends `/mcp*` to the workers) as the user. The access token is minted locally with the authorization server's own
 * signing key (`typ at+jwt`, audience `https://host/mcp`, 60 s, client id `bastion-ui`), so every worker verifies it
 * exactly like any other token and applies the full pipeline of 4.4.
 */
import { randomUUID } from 'node:crypto';
import { buildPrincipal, type Principal } from '@bastion-mcp/auth';
import { BastionError, effectiveTeamSlug } from '@bastion-mcp/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { importJWK, SignJWT } from 'jose';
import { SERVER_VERSION } from '../config';
import type { AuthServices } from '../contracts';
import type { Infra } from '../infra';

export const mintAccessToken = async (
  infra: Infra,
  auth: Pick<AuthServices, 'keyStore'>,
  principalId: string,
): Promise<string> => {
  const keys = await auth.keyStore.listSigningKeys('as');
  const now = Date.now();
  const active = keys
    .filter((k) => k.activeFrom.getTime() <= now && k.retireAfter.getTime() > now)
    .sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime())[0];
  if (!active) throw new Error('no usable signing key');
  const jwk = await auth.keyStore.loadSigningPrivateKey(active.kid);
  const key = await importJWK(jwk as never, 'ES256');
  return new SignJWT({ scope: 'mcp', client_id: 'bastion-ui', 'bastion:pt': 'user' })
    .setProtectedHeader({ alg: 'ES256', kid: active.kid, typ: 'at+jwt' })
    .setSubject(principalId)
    .setIssuer(infra.config.urls.issuer)
    .setAudience(`${infra.config.publicUrl}/mcp`)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(key);
};

/** The principal the caller acts as (active only), built like a browser session's. */
export const principalFor = async (
  auth: Pick<AuthServices, 'principalStore'>,
  principalId: string,
): Promise<Principal> => {
  const record = await auth.principalStore.getPrincipal(principalId);
  if (!record?.active) {
    throw new BastionError('POLICY_DENIED', 'the principal is not active', { httpStatus: 403 });
  }
  return buildPrincipal(record, { authMethod: 'session', clientId: 'bastion-ui', scopes: ['mcp'] });
};

/** The slug in `/mcp/i/{slug}`: team installations are addressed as `{teamSlug}-{slug}` (7.1). */
export const effectiveSlugOf = async (infra: Infra, installationId: string): Promise<string> => {
  const row = await infra.db.prisma.installation.findUnique({
    where: { id: installationId },
    select: { slug: true, ownerType: true, ownerId: true },
  });
  if (!row) throw new BastionError('NOT_FOUND', 'installation not found', { httpStatus: 404 });
  if (row.ownerType !== 'team') return row.slug;
  const team = await infra.db.prisma.team.findUnique({
    where: { id: row.ownerId },
    select: { slug: true },
  });
  return team ? effectiveTeamSlug(team.slug, row.slug) : row.slug;
};

/** Connects the MCP client to one installation endpoint of this deployment as `principalId`. */
export const connectAsPrincipal = async (
  infra: Infra,
  auth: Pick<AuthServices, 'keyStore'>,
  principalId: string,
  slug: string,
): Promise<Client> => {
  const token = await mintAccessToken(infra, auth, principalId);
  const client = new Client({ name: 'bastion-ui', version: SERVER_VERSION }, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  } as never);
  const transport = new StreamableHTTPClientTransport(
    new URL(`${infra.config.publicUrl}/mcp/i/${slug}`),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      ...(infra.options.fetch ? { fetch: infra.options.fetch } : {}),
    } as never,
  );
  await client.connect(transport);
  return client;
};
