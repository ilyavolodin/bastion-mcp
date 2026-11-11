import { describe, expect, it } from 'vitest';
import { mapOauthPath } from '../../src/oauth/as/server';

describe('9.3 mapOauthPath', () => {
  it('9.3 maps the RFC 8414 path form to the OIDC discovery path', () => {
    expect(mapOauthPath('/.well-known/oauth-authorization-server/oauth')).toBe(
      '/.well-known/openid-configuration',
    );
  });

  it('9.3 strips the /oauth prefix and maps the bare mount to the root', () => {
    expect(mapOauthPath('/oauth/token')).toBe('/token');
    expect(mapOauthPath('/oauth/device/auth')).toBe('/device/auth');
    expect(mapOauthPath('/oauth')).toBe('/');
    expect(mapOauthPath('/oauth/')).toBe('/');
  });

  it('9.3 does not serve any other path', () => {
    expect(mapOauthPath('/')).toBeUndefined();
    expect(mapOauthPath('/oauthx')).toBeUndefined();
    expect(mapOauthPath('/mcp')).toBeUndefined();
    expect(mapOauthPath('/.well-known/oauth-authorization-server')).toBeUndefined();
  });
});
