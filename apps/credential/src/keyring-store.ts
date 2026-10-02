import type { TokenStore } from './store';

export const KEYCHAIN_SERVICE = 'bastion-credential';

/** The OS keychain through `@napi-rs/keyring` (loaded lazily: it is a native module). */
export class KeyringTokenStore implements TokenStore {
  private async entry(serverUrl: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(KEYCHAIN_SERVICE, serverUrl);
  }
  async get(serverUrl: string): Promise<string | undefined> {
    return (await (await this.entry(serverUrl)).getPassword()) ?? undefined;
  }
  async set(serverUrl: string, refreshToken: string): Promise<void> {
    await (await this.entry(serverUrl)).setPassword(refreshToken);
  }
  async delete(serverUrl: string): Promise<void> {
    await (await this.entry(serverUrl)).deletePassword();
  }
}
