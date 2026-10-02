import type { KeyStore } from '@bastion-mcp/secrets';
import type { Infra } from '../infra';

/** `repos.keyStore` exists because `createInfra` passes the vault; this narrows the optional type. */
export const keyStoreOf = (infra: Infra): KeyStore => {
  const store = (infra.repos as { keyStore?: KeyStore }).keyStore;
  if (!store) throw new Error('key store is not available (secret vault missing)');
  return store;
};
