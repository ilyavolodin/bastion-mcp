import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAwsClient,
  createAzureClient,
  createGcpClient,
  createKmsProvider,
  createVaultTransitClient,
  KmsUnavailableError,
  LocalKmsProvider,
  type ModuleLoader,
  parseVaultKey,
  type RawKmsClient,
  RemoteKmsProvider,
  withTimeout,
} from '../src';

const tmp = () => mkdtempSync(join(tmpdir(), 'bastion-kms-'));

describe('local KMS', () => {
  it('19.1 generates a 32-byte key file on first start and reuses it', async () => {
    const path = join(tmp(), 'sub', 'kek');
    const a = new LocalKmsProvider(path);
    const dek = randomBytes(32);
    const wrapped = await a.wrap(dek);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toHaveLength(32);
    const b = new LocalKmsProvider(path);
    expect(b.kekRef).toBe(a.kekRef);
    expect((await b.unwrap(wrapped, a.kekRef)).equals(dek)).toBe(true);
    expect((await b.health()).ok).toBe(true);
  });

  it('19.1 reads a 64-hex key file and rejects other sizes', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'hex'), randomBytes(32).toString('hex'));
    const ok = new LocalKmsProvider(join(dir, 'hex'));
    expect((await ok.wrap(randomBytes(32))).length).toBeGreaterThan(32);
    writeFileSync(join(dir, 'bad'), 'short');
    const bad = new LocalKmsProvider(join(dir, 'bad'));
    await expect(bad.wrap(randomBytes(32))).rejects.toBeInstanceOf(KmsUnavailableError);
    expect((await bad.health()).ok).toBe(false);
  });

  it('19.1 reports an unreadable key path', async () => {
    const dir = tmp(); // a directory is not a readable key file
    const p = new LocalKmsProvider(dir);
    await expect(p.wrap(randomBytes(32))).rejects.toBeInstanceOf(KmsUnavailableError);
  });

  it('22.3 unwraps rows from a previous local key by kek_ref', async () => {
    const dir = tmp();
    const oldKey = randomBytes(32);
    writeFileSync(join(dir, 'old'), oldKey);
    const old = new LocalKmsProvider(join(dir, 'old'));
    const wrapped = await old.wrap(randomBytes(32));
    const next = new LocalKmsProvider(join(dir, 'new'), [oldKey]);
    expect(next.kekRef).not.toBe(old.kekRef);
    await expect(next.unwrap(wrapped, old.kekRef)).resolves.toHaveLength(32);
    await expect(next.unwrap(wrapped, 'local:unknown')).rejects.toBeInstanceOf(KmsUnavailableError);
  });

  it('22.3 rejects tampered or truncated wrapped keys', async () => {
    const p = new LocalKmsProvider(join(tmp(), 'k'));
    const w = await p.wrap(randomBytes(32));
    w[w.length - 1] = (w[w.length - 1] ?? 0) ^ 1;
    await expect(p.unwrap(w, p.kekRef)).rejects.toBeInstanceOf(KmsUnavailableError);
    await expect(p.unwrap(Buffer.alloc(4), p.kekRef)).rejects.toBeInstanceOf(KmsUnavailableError);
  });
});

describe('withTimeout', () => {
  it('21.3 rejects when the call exceeds the timeout', async () => {
    await expect(withTimeout(() => new Promise(() => undefined), 20)).rejects.toThrow();
  });

  it('21.3 rejects when the caller aborts and passes a signal through', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const p = withTimeout(
      (s) => {
        seen = s;
        return new Promise(() => undefined);
      },
      1000,
      ac.signal,
    );
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(seen?.aborted).toBe(true);
    await expect(withTimeout(async () => 1, 1000, ac.signal)).rejects.toThrow();
  });

  it('returns the value on success', async () => {
    await expect(withTimeout(async () => 7, 1000)).resolves.toBe(7);
  });
});

describe('remote provider', () => {
  const fake = (): RawKmsClient & { calls: string[] } => ({
    calls: [],
    async encrypt(k, p) {
      this.calls.push(`enc:${k}`);
      return Buffer.concat([Buffer.from('E'), p]);
    },
    async decrypt(k, c) {
      this.calls.push(`dec:${k}`);
      return Buffer.from(c).subarray(1);
    },
  });

  it('22.3 wraps, unwraps with the stored key ref and reports health', async () => {
    const client = fake();
    const p = new RemoteKmsProvider('aws', 'arn:key/1', client);
    expect(p.kekRef).toBe('aws:arn:key/1');
    const dek = randomBytes(32);
    const w = await p.wrap(dek);
    expect((await p.unwrap(w, 'aws:arn:key/0')).equals(dek)).toBe(true);
    expect(client.calls).toContain('dec:arn:key/0');
    expect((await p.health()).ok).toBe(true);
  });

  it('22.3 rejects a kek_ref of another provider', async () => {
    const p = new RemoteKmsProvider('aws', 'k', fake());
    await expect(p.unwrap(Buffer.alloc(1), 'gcp:k')).rejects.toBeInstanceOf(KmsUnavailableError);
  });

  it('21.3 maps client failures and timeouts to KmsUnavailableError', async () => {
    const failing: RawKmsClient = {
      encrypt: () => Promise.reject(new Error('boom')),
      decrypt: () => new Promise(() => undefined),
    };
    const p = new RemoteKmsProvider('gcp', 'k', failing, 20);
    await expect(p.wrap(Buffer.alloc(32))).rejects.toBeInstanceOf(KmsUnavailableError);
    await expect(p.unwrap(Buffer.alloc(1), 'gcp:k')).rejects.toBeInstanceOf(KmsUnavailableError);
    const h = await p.health();
    expect(h.ok).toBe(false);
  });

  it('22.3 health fails when the round trip does not match', async () => {
    const lying: RawKmsClient = {
      encrypt: async (_k, p) => p,
      decrypt: async () => Buffer.alloc(32),
    };
    expect((await new RemoteKmsProvider('gcp', 'k', lying).health()).detail).toMatch(/mismatch/);
  });
});

describe('vault transit', () => {
  it('19.1 parses transit/keys/<name>', () => {
    expect(parseVaultKey('transit/keys/bastion')).toEqual({ mount: 'transit', name: 'bastion' });
    expect(parseVaultKey('kms/transit/keys/b')).toEqual({ mount: 'kms/transit', name: 'b' });
    expect(() => parseVaultKey('nope')).toThrow(KmsUnavailableError);
  });

  it('19.1 calls encrypt and decrypt with token, abort signal and base64 payloads', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = createVaultTransitClient({
      address: 'https://vault.local/',
      token: 'tok',
      fetch: async (url, init) => {
        seen.push({ url, init });
        const body = JSON.parse(String(init.body)) as Record<string, string>;
        return url.includes('/encrypt/')
          ? Response.json({ data: { ciphertext: `vault:v1:${body.plaintext}` } })
          : Response.json({ data: { plaintext: body.ciphertext?.replace('vault:v1:', '') } });
      },
    });
    const p = new RemoteKmsProvider('vault', 'transit/keys/b', client);
    const dek = randomBytes(32);
    const w = await p.wrap(dek);
    expect(w.toString()).toMatch(/^vault:v1:/);
    expect((await p.unwrap(w, p.kekRef)).equals(dek)).toBe(true);
    expect(seen[0]?.url).toBe('https://vault.local/v1/transit/encrypt/b');
    expect(seen[0]?.init.headers).toMatchObject({ 'X-Vault-Token': 'tok' });
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(seen[1]?.url).toBe('https://vault.local/v1/transit/decrypt/b');
  });

  it('19.1 fails on HTTP errors and malformed bodies', async () => {
    const mk = (res: () => Response) =>
      new RemoteKmsProvider(
        'vault',
        'transit/keys/b',
        createVaultTransitClient({ address: 'http://v', token: 't', fetch: async () => res() }),
      );
    await expect(
      mk(() => new Response('no', { status: 503 })).wrap(Buffer.alloc(32)),
    ).rejects.toBeInstanceOf(KmsUnavailableError);
    await expect(mk(() => Response.json({ x: 1 })).wrap(Buffer.alloc(32))).rejects.toBeInstanceOf(
      KmsUnavailableError,
    );
  });

  it('19.1 uses global fetch when none is injected', async () => {
    const client = createVaultTransitClient({ address: 'http://127.0.0.1:1', token: 't' });
    await expect(
      client.encrypt('transit/keys/b', Buffer.alloc(1), AbortSignal.timeout(500)),
    ).rejects.toThrow();
  });
});

describe('cloud SDK adapters load lazily', () => {
  it('19.1 gcp: loads @google-cloud/kms only on first use', async () => {
    const loaded: string[] = [];
    class KeyManagementServiceClient {
      async encrypt(req: { name: string; plaintext: Uint8Array }) {
        return [{ ciphertext: Buffer.concat([Buffer.from('g'), req.plaintext]) }];
      }
      async decrypt(req: { ciphertext: Uint8Array }) {
        return [{ plaintext: Buffer.from(req.ciphertext).subarray(1).toString('base64') }];
      }
    }
    const load: ModuleLoader = async (n) => {
      loaded.push(n);
      return { KeyManagementServiceClient };
    };
    const p = createKmsProvider({ kms: 'gcp', kmsKey: 'projects/p/k' }, { loader: load });
    expect(loaded).toEqual([]);
    const dek = randomBytes(32);
    const w = await p.wrap(dek);
    expect((await p.unwrap(w, p.kekRef)).equals(dek)).toBe(true);
    expect(loaded).toEqual(['@google-cloud/kms']);
  });

  it('19.1 aws: sends Encrypt/Decrypt commands with an abort signal', async () => {
    const sent: { cmd: unknown; opts: unknown }[] = [];
    class KMSClient {
      async send(cmd: { kind: string; input: Record<string, Uint8Array> }, opts: unknown) {
        sent.push({ cmd, opts });
        return cmd.kind === 'enc'
          ? { CiphertextBlob: cmd.input.Plaintext }
          : { Plaintext: cmd.input.CiphertextBlob };
      }
    }
    class EncryptCommand {
      kind = 'enc';
      constructor(public input: unknown) {}
    }
    class DecryptCommand {
      kind = 'dec';
      constructor(public input: unknown) {}
    }
    const p = createKmsProvider(
      { kms: 'aws', kmsKey: 'arn:aws:kms:k' },
      { loader: async () => ({ KMSClient, EncryptCommand, DecryptCommand }) },
    );
    const dek = randomBytes(32);
    expect((await p.unwrap(await p.wrap(dek), p.kekRef)).equals(dek)).toBe(true);
    expect(sent[0]?.opts).toMatchObject({ abortSignal: expect.any(AbortSignal) });
  });

  it('19.1 azure: wraps with RSA-OAEP-256 through CryptographyClient', async () => {
    const algs: string[] = [];
    class CryptographyClient {
      constructor(
        public url: string,
        public cred: unknown,
      ) {}
      async wrapKey(alg: string, k: Uint8Array) {
        algs.push(alg);
        return { result: k };
      }
      async unwrapKey(_alg: string, k: Uint8Array) {
        return { result: k };
      }
    }
    class DefaultAzureCredential {}
    const loader: ModuleLoader = async (n) =>
      n === '@azure/identity' ? { DefaultAzureCredential } : { CryptographyClient };
    const p = createKmsProvider(
      { kms: 'azure', kmsKey: 'https://v.vault.azure.net/keys/k' },
      { loader },
    );
    const dek = randomBytes(32);
    expect((await p.unwrap(await p.wrap(dek), p.kekRef)).equals(dek)).toBe(true);
    expect(algs).toEqual(['RSA-OAEP-256']);
  });

  it('19.1 reports a missing SDK as KmsUnavailableError and retries loading later', async () => {
    let attempts = 0;
    const client = createGcpClient(async () => {
      attempts++;
      return {};
    });
    await expect(client.encrypt('k', Buffer.alloc(1), AbortSignal.timeout(1000))).rejects.toThrow(
      /install/,
    );
    await expect(client.encrypt('k', Buffer.alloc(1), AbortSignal.timeout(1000))).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it('19.1 rejects SDK responses without the expected bytes', async () => {
    class KMSClient {
      async send() {
        return {};
      }
    }
    const client = createAwsClient(async () => ({
      KMSClient,
      EncryptCommand: class {},
      DecryptCommand: class {},
    }));
    await expect(client.encrypt('k', Buffer.alloc(1), AbortSignal.timeout(1000))).rejects.toThrow(
      /CiphertextBlob/,
    );
    const az = createAzureClient(async (n) =>
      n === '@azure/identity'
        ? { default: { DefaultAzureCredential: class {} } }
        : {
            CryptographyClient: class {
              async unwrapKey() {
                return {};
              }
            },
          },
    );
    await expect(az.decrypt('u', Buffer.alloc(1), AbortSignal.timeout(1000))).rejects.toThrow(
      /result/,
    );
  });
});

describe('createKmsProvider', () => {
  it('19.1 selects local by default and honors the key path', () => {
    const path = join(tmp(), 'kek');
    const p = createKmsProvider({ kms: 'local', kmsKey: path });
    expect(p).toBeInstanceOf(LocalKmsProvider);
    expect(p.kekRef).toMatch(/^local:[0-9a-f]{16}$/);
  });

  it('19.1 requires BASTION_KMS_KEY for remote providers', () => {
    expect(() => createKmsProvider({ kms: 'aws' })).toThrow(/BASTION_KMS_KEY/);
  });

  it('19.1 vault needs address and token from the environment', async () => {
    expect(() =>
      createKmsProvider({ kms: 'vault', kmsKey: 'transit/keys/b' }, { env: {} }),
    ).toThrow(/VAULT_ADDR/);
    const p = createKmsProvider(
      { kms: 'vault', kmsKey: 'transit/keys/b' },
      {
        env: { VAULT_ADDR: 'http://v', VAULT_TOKEN: 't' },
        fetch: async () => Response.json({ data: { ciphertext: 'vault:v1:x' } }),
      },
    );
    expect(p.kekRef).toBe('vault:transit/keys/b');
    expect((await p.wrap(Buffer.alloc(32))).toString()).toBe('vault:v1:x');
  });
});
