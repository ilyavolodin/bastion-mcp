import {
  type DeviceAuthorization,
  discoverEndpoints,
  type FetchFn,
  type OAuthEndpoints,
  pollForToken,
  refreshAccessToken,
  requestDeviceAuthorization,
  type TokenResponse,
} from './device-flow';
import type { TokenStore } from './store';

const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_LIFETIME_S = 300;

export type TokenManagerDeps = {
  server: URL;
  store: TokenStore;
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Shows the verification URL and code to the user and opens the browser. */
  prompt: (authorization: DeviceAuthorization) => Promise<void>;
};

/**
 * Hands out access tokens (25.6). Access tokens are cached in memory only; the refresh token is kept
 * in the `TokenStore` (the OS keychain). When it is missing or expired the device grant runs.
 */
export class TokenManager {
  private cached: { token: string; expiresAt: number } | undefined;
  private endpoints: OAuthEndpoints | undefined;

  constructor(private readonly deps: TokenManagerDeps) {}

  private async getEndpoints(): Promise<OAuthEndpoints> {
    this.endpoints ??= await discoverEndpoints(this.deps.server, this.deps.fetch);
    return this.endpoints;
  }

  private remember(response: TokenResponse): string {
    this.cached = {
      token: response.access_token,
      expiresAt: this.deps.now() + (response.expires_in ?? DEFAULT_LIFETIME_S) * 1000,
    };
    return response.access_token;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > this.deps.now()) {
      return this.cached.token;
    }
    const endpoints = await this.getEndpoints();
    const key = this.deps.server.origin;
    const refreshToken = await this.deps.store.get(key);
    if (refreshToken) {
      const refreshed = await refreshAccessToken(endpoints, refreshToken, this.deps.fetch);
      if (refreshed) {
        if (refreshed.refresh_token) await this.deps.store.set(key, refreshed.refresh_token);
        return this.remember(refreshed);
      }
      await this.deps.store.delete(key);
    }
    const authorization = await requestDeviceAuthorization(endpoints, this.deps.fetch);
    await this.deps.prompt(authorization);
    const token = await pollForToken(endpoints, authorization, this.deps);
    if (token.refresh_token) await this.deps.store.set(key, token.refresh_token);
    return this.remember(token);
  }
}
