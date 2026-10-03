/**
 * Public surface of the OAuth half of `@bastion-mcp/auth`: embedded authorization server (9.3, 9.4), IdP
 * login (9.1), per-user upstream OAuth and credential resolution (9.5 to 9.7).
 *
 * Port names that would collide with the identity half are exported with an `OAuth` prefix.
 */

export {
  ClientRegistrationError,
  type PreparedClient,
  type PreRegisterInput,
} from './as/clients';
export type { ConsentView } from './as/consent';
export type { IdJagVerifier } from './as/id-jag-grant';
export type { InteractionApi, InteractionView } from './as/interaction';
export type { ProviderPages } from './as/provider-pages';
export {
  admitRegistration,
  classifyRedirectUri,
  defaultApplicationType,
  isCimdHostAllowed,
} from './as/registration';
// Embedded authorization server
export {
  type AuthorizationServer,
  type AuthorizationServerDeps,
  createAuthorizationServer,
} from './as/server';
// Constants and URL helpers
export {
  ACCESS_TOKEN_TTL_S,
  BASTION_SCOPES,
  CONSENT_TTL_S,
  CREDENTIAL_CLIENT_ID,
  ENTERPRISE_MANAGED_EXTENSION,
  JWT_BEARER_GRANT,
} from './constants';
export { OAuthProtocolError } from './http';
export {
  createIdJagVerifier,
  IdJagError,
  type IdJagVerifierDeps,
  type JtiGuard,
  MemoryJtiGuard,
} from './idp/id-jag';
// IdP login
export {
  IdpClients,
  type IdpDeps,
  IdpLogin,
  type IdpLoginDeps,
  IdpLoginError,
  type IdpTokenSet,
  type LoginResult,
  type LoginStart,
} from './idp/login';
export {
  DEFAULT_CLAIM_MAP,
  emailDomain,
  IdpClaimError,
  isEmailDomainAllowed as isIdpEmailDomainAllowed,
  loginScopes,
  mapClaims as mapIdpClaims,
  type NormalizedProfile,
  routeByEmail,
} from './idp/profile';
export { type ConnectionTestResult, testIdpConnection } from './idp/test-connection';
export { IdpRefreshError, IdpTokenVault, refreshIdpTokens } from './idp/tokens';
export { noopMetrics, type OAuthMetrics, type RefreshOutcome, withRefreshSpan } from './metrics';
// Ports
export type {
  ClaimMap as OAuthClaimMap,
  ClientRegistrationSettings,
  Clock as OAuthClock,
  FetchFn,
  IdpConnection as OAuthIdpConnection,
  IdpConnectionStore as OAuthIdpConnectionStore,
  IdpTokenRow,
  IdpTokenStore,
  OAuthClientPolicy,
  OAuthClientPolicyStore,
  OidcModelRow,
  OidcModelStore,
  PrincipalDirectory,
  PrincipalType as OAuthPrincipalType,
  RedisLike as OAuthRedisLike,
  RegistrationSettingsSource,
  SecretRef,
  SecretStore,
  SigningKeySource as OAuthSigningKeySource,
  UpstreamClientRow,
  UpstreamClientStore,
  UpstreamTokenRow,
  UpstreamTokenStatus,
  UpstreamTokenStore,
} from './ports';
export { systemClock as oauthSystemClock } from './ports';
// Outbound safety and metrics hooks
export {
  assertOutboundUrl,
  createSafeFetch,
  OutboundDeniedError,
  type OutboundPolicy,
} from './safe-fetch';
// Upstream OAuth
export {
  type BrokerDeps,
  type ConnectPageModel,
  type InstallationLookup,
  type OAuthInstallation,
  type UpstreamAccessToken,
  UpstreamOAuthBroker,
  type UpstreamPrincipal,
  type UpstreamTokenStatusView,
} from './upstream/broker';
export {
  buildUpstreamClientMetadata,
  buildUpstreamJwksDocument,
  UpstreamClientError,
} from './upstream/client-identity';
export {
  discoverUpstream,
  type UpstreamDiscovery,
  UpstreamDiscoveryError,
} from './upstream/discovery';
export { type IdpMintedDeps, IdpMintedTokens, type MintedToken } from './upstream/idp-minted';
export {
  buildInjections,
  decidePackageTokenAction,
  OAuthConfigError,
  type PackageTokenDecision,
  type ResolvedInjection,
} from './upstream/injection';
export {
  type ResolvedCredential,
  type ResolverInstallation,
  type SecretResolver,
  UpstreamCredentialResolver,
} from './upstream/resolver';
export { openUpstreamState, sealUpstreamState, UpstreamStateError } from './upstream/state';
export {
  apiResource,
  buildProtectedResourceMetadata,
  connectUrl,
  idpCallbackUrl,
  idpRedirectUri,
  isAllowedResource,
  issuerFor,
  mcpResource,
  upstreamCallbackUrl,
  upstreamClientMetadataUrl,
  upstreamJwksUrl,
} from './urls';
