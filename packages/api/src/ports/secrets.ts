export type SecretScope = 'org' | 'team' | 'user';

export type SecretMeta = {
  id: string;
  scope: SecretScope;
  ownerId: string | null;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** Names and metadata only; values go in through `put` and never come back (22.3). */
export interface SecretsPort {
  list(filter: { scope: SecretScope; ownerId: string | null }): Promise<SecretMeta[]>;
  put(key: {
    scope: SecretScope;
    ownerId: string | null;
    name: string;
    value: string;
  }): Promise<SecretMeta>;
  delete(key: { scope: SecretScope; ownerId: string | null; name: string }): Promise<boolean>;
}
