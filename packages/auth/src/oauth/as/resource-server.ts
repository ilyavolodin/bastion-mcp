import { ACCESS_TOKEN_TTL_S } from '../constants';
import { apiResource } from '../urls';

export type ResourceServerInfo = {
  scope: string;
  audience: string;
  accessTokenFormat: 'jwt';
  accessTokenTTL: number;
  jwt: { sign: { alg: 'ES256' } };
};

/** RFC 8707 resource server description: JWT access tokens (RFC 9068), ES256, 15 minutes (9.3). */
export const resourceServerInfo = (host: string, resource: string): ResourceServerInfo => ({
  scope:
    resource === apiResource(host)
      ? 'api:read api:write offline_access'
      : 'mcp plugins:read offline_access',
  audience: resource,
  accessTokenFormat: 'jwt',
  accessTokenTTL: ACCESS_TOKEN_TTL_S,
  jwt: { sign: { alg: 'ES256' } },
});
