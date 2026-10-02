import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAuthorizationServer } from '../../src/oauth/as/server';
import type { Harness } from './as-harness';
import { MemoryOidcModels, MemoryPolicies, MemoryRedis, MemorySigningKeys } from './fakes';

/** A reduced harness whose AS seals client secrets with a keyring (22.3). */
export const startHarnessWithKeyring = async (): Promise<
  Pick<Harness, 'as' | 'base' | 'models' | 'serviceAccounts' | 'close' | 'browser'>
> => {
  const models = new MemoryOidcModels();
  const keys = new MemorySigningKeys();
  keys.add(new Date(Date.now() - 1000), new Date(Date.now() + 86_400_000));
  const serviceAccounts = new Map<string, string>();
  const as = await createAuthorizationServer({
    host: 'bastion.test',
    orgName: 'Acme',
    models,
    signingKeys: keys,
    clientPolicies: new MemoryPolicies(),
    registration: { get: async () => ({ cimd: true, dcr: true, cimdHostAllowlist: [] }) },
    principals: {
      isUserActive: async () => true,
      serviceAccountForClient: async (id) => {
        const sa = serviceAccounts.get(id);
        return sa ? { id: sa } : null;
      },
    },
    redis: new MemoryRedis(),
    cookieKeys: ['k'],
    clientSecretKeyring: { activeKid: 'k1', keys: new Map([['k1', randomBytes(32)]]) },
  });
  const server = createServer((req, res) => void as.listener(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = () => {
    const request = (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-forwarded-host', 'bastion.test');
      return fetch(url.replace('https://bastion.test', base), {
        ...init,
        headers,
        redirect: 'manual',
      });
    };
    return { jar: new Map<string, string>(), request, authorize: async () => new URL(base) };
  };
  return {
    as,
    base,
    models,
    serviceAccounts,
    browser,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
