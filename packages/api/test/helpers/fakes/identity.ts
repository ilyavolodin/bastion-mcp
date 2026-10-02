import type { ApiDeps } from '../../../src/ports';
import type { FakeCtx } from '../harness';

/** Discovery test: succeeds for the seeded IdP issuer, reports a mismatch otherwise. */
export const fakeIdentityDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  identity: {
    testIdp: async (input) =>
      input.issuer === 'https://idp.example.com'
        ? {
            ok: true,
            issuer: input.issuer,
            issuerMatches: true,
            endpoints: {
              authorization: `${input.issuer}/authorize`,
              token: `${input.issuer}/token`,
            },
          }
        : {
            ok: false,
            issuer: 'https://other.example.com',
            issuerMatches: false,
            error: 'issuer mismatch',
          },
  },
});
