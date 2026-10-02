/** Where the refresh token lives. Production: the OS keychain; tests: memory. */
export interface TokenStore {
  get(serverUrl: string): Promise<string | undefined>;
  set(serverUrl: string, refreshToken: string): Promise<void>;
  delete(serverUrl: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  readonly tokens = new Map<string, string>();
  async get(serverUrl: string): Promise<string | undefined> {
    return this.tokens.get(serverUrl);
  }
  async set(serverUrl: string, refreshToken: string): Promise<void> {
    this.tokens.set(serverUrl, refreshToken);
  }
  async delete(serverUrl: string): Promise<void> {
    this.tokens.delete(serverUrl);
  }
}
