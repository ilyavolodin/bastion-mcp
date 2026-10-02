import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CREDENTIAL_CLIENT_ID } from '../constants';
import { defaultApplicationType, findDisallowedRedirectUris } from './registration';

/** Admin pre-registered clients (`POST /oauth-clients`, 17.2) and service-account clients (9.3). */
const preRegisterSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('public'),
    name: z.string().min(1).max(200),
    redirectUris: z.array(z.string()).min(1),
    logoUri: z.url().optional(),
    clientId: z.string().min(1).optional(),
    scope: z.string().optional(),
    /** Extra grant types, for example the ID-JAG jwt-bearer grant (9.4). */
    extraGrantTypes: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('service'),
    name: z.string().min(1).max(200),
    authMethod: z.enum(['client_secret_basic', 'private_key_jwt']),
    jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) }).optional(),
    clientId: z.string().min(1).optional(),
    scope: z.string().optional(),
  }),
]);

export type PreRegisterInput = z.input<typeof preRegisterSchema>;

export type PreparedClient = {
  /** `Client` payload for `oidc_models`. */
  payload: Record<string, unknown>;
  clientId: string;
  /** Shown once to the admin; absent for public and `private_key_jwt` clients. */
  clientSecret: string | null;
};

export class ClientRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientRegistrationError';
  }
}

export const prepareClient = (rawInput: PreRegisterInput): PreparedClient => {
  const input = preRegisterSchema.parse(rawInput);
  const clientId = input.clientId ?? randomUUID();
  if (clientId === CREDENTIAL_CLIENT_ID) throw new ClientRegistrationError('reserved client id');
  if (input.kind === 'public') {
    if (findDisallowedRedirectUris(input.redirectUris).length > 0) {
      throw new ClientRegistrationError(
        'redirect URIs must use https, loopback or a private-use scheme',
      );
    }
    return {
      clientId,
      clientSecret: null,
      payload: {
        client_id: clientId,
        client_name: input.name,
        ...(input.logoUri ? { logo_uri: input.logoUri } : {}),
        redirect_uris: input.redirectUris,
        grant_types: ['authorization_code', 'refresh_token', ...(input.extraGrantTypes ?? [])],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: defaultApplicationType(input.redirectUris),
        ...(input.scope ? { scope: input.scope } : {}),
      },
    };
  }
  if (input.authMethod === 'private_key_jwt' && !input.jwks) {
    throw new ClientRegistrationError('private_key_jwt clients need jwks');
  }
  const secret =
    input.authMethod === 'client_secret_basic' ? randomBytes(48).toString('base64url') : null;
  return {
    clientId,
    clientSecret: secret,
    payload: {
      client_id: clientId,
      client_name: input.name,
      grant_types: ['client_credentials'],
      response_types: [],
      token_endpoint_auth_method: input.authMethod,
      ...(secret ? { client_secret: secret } : {}),
      ...(input.jwks ? { jwks: input.jwks } : {}),
      scope: input.scope ?? 'mcp',
    },
  };
};
