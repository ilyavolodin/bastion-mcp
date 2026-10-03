import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex } from '@bastion-mcp/core';
import { z } from 'zod';
import { KmsUnavailableError } from './errors';
import type { KmsProvider } from './types';

export const KMS_TIMEOUT_MS = 5000;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Races `fn` against a timeout and the caller's signal; the combined signal is passed to `fn`. */
export const withTimeout = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(combined.reason ?? new Error('aborted'));
    combined.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([fn(combined), aborted]);
  } finally {
    if (onAbort) combined.removeEventListener('abort', onAbort);
  }
};

/* ------------------------------ local provider ------------------------------ */

const fingerprint = (key: Buffer): string => sha256Hex(key).slice(0, 16);

const parseKeyFile = (content: Buffer): Buffer => {
  if (content.length === KEY_BYTES) return content;
  const text = content.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  throw new KmsUnavailableError('local KEK file must hold exactly 32 bytes (or 64 hex characters)');
};

/**
 * Local KEK (19.1): a 32-byte key in a file, generated on first start when absent. `previousKeys`
 * lets rows wrapped under an older local key still unwrap during rotation.
 */
export class LocalKmsProvider implements KmsProvider {
  private cached: Buffer | undefined;

  constructor(
    private readonly keyPath: string,
    private readonly previousKeys: readonly Buffer[] = [],
  ) {}

  /** Reads (or creates) the key file on first use; `kekRef` is `local:<sha256 fingerprint>`. */
  get kekRef(): string {
    return `local:${fingerprint(this.loadKey())}`;
  }

  private loadKey(): Buffer {
    this.cached ??= this.readOrCreate();
    return this.cached;
  }

  private readOrCreate(): Buffer {
    try {
      return parseKeyFile(readFileSync(this.keyPath));
    } catch (error) {
      if (error instanceof KmsUnavailableError) throw error;
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new KmsUnavailableError('cannot read local KEK file', error);
      }
    }
    const key = randomBytes(KEY_BYTES);
    mkdirSync(dirname(this.keyPath), { recursive: true });
    try {
      writeFileSync(this.keyPath, key, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (error) {
      // Lost a race with another process starting at the same time: use its key.
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return parseKeyFile(readFileSync(this.keyPath));
      }
      throw new KmsUnavailableError('cannot create local KEK file', error);
    }
  }

  async wrap(dek: Buffer): Promise<Buffer> {
    const key = this.loadKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  async unwrap(wrapped: Buffer, kekRef: string): Promise<Buffer> {
    const current = this.loadKey();
    const candidates = [current, ...this.previousKeys].filter((k) => {
      const ref = `local:${fingerprint(k)}`;
      return ref.length === kekRef.length && timingSafeEqual(Buffer.from(ref), Buffer.from(kekRef));
    });
    const key = candidates[0];
    if (!key) throw new KmsUnavailableError('no local KEK matches the stored kek_ref');
    if (wrapped.length < IV_BYTES + TAG_BYTES)
      throw new KmsUnavailableError('malformed wrapped key');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch (error) {
      throw new KmsUnavailableError('local KEK failed to unwrap the data key', error);
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      this.loadKey();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
    }
  }
}

/* ------------------------- remote providers (gcp/aws/azure/vault) ------------------------- */

/** The two operations every remote KMS adapter implements. `keyRef` is the provider's key name. */
export interface RawKmsClient {
  encrypt(keyRef: string, plaintext: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  decrypt(keyRef: string, ciphertext: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}

export type RemoteKmsKind = 'gcp' | 'aws' | 'azure' | 'vault';

/** Shared KmsProvider over a raw client: timeouts, abort, error mapping, `kekRef = <kind>:<key>`. */
export class RemoteKmsProvider implements KmsProvider {
  readonly kekRef: string;

  constructor(
    private readonly kind: RemoteKmsKind,
    private readonly key: string,
    private readonly client: RawKmsClient,
    private readonly timeoutMs: number = KMS_TIMEOUT_MS,
  ) {
    this.kekRef = `${kind}:${key}`;
  }

  async wrap(dek: Buffer, signal?: AbortSignal): Promise<Buffer> {
    try {
      const out = await withTimeout(
        (s) => this.client.encrypt(this.key, dek, s),
        this.timeoutMs,
        signal,
      );
      return Buffer.from(out);
    } catch (error) {
      throw new KmsUnavailableError(`${this.kind} KMS wrap failed`, error);
    }
  }

  async unwrap(wrapped: Buffer, kekRef: string, signal?: AbortSignal): Promise<Buffer> {
    const prefix = `${this.kind}:`;
    if (!kekRef.startsWith(prefix)) {
      throw new KmsUnavailableError(
        `kek_ref "${kekRef}" does not belong to the ${this.kind} provider`,
      );
    }
    const key = kekRef.slice(prefix.length);
    try {
      const out = await withTimeout(
        (s) => this.client.decrypt(key, wrapped, s),
        this.timeoutMs,
        signal,
      );
      return Buffer.from(out);
    } catch (error) {
      throw new KmsUnavailableError(`${this.kind} KMS unwrap failed`, error);
    }
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    try {
      const probe = randomBytes(KEY_BYTES);
      const back = await this.unwrap(await this.wrap(probe, signal), this.kekRef, signal);
      return probe.equals(back) ? { ok: true } : { ok: false, detail: 'round trip mismatch' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
    }
  }
}

/* --------------------------------- Vault Transit --------------------------------- */

const vaultEncryptResponse = z.object({ data: z.object({ ciphertext: z.string() }) });
const vaultDecryptResponse = z.object({ data: z.object({ plaintext: z.string() }) });

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Splits `transit/keys/<name>` into the mount path and key name. */
export const parseVaultKey = (kmsKey: string): { mount: string; name: string } => {
  const match = /^(.+?)\/keys\/([^/]+)$/.exec(kmsKey);
  if (!match?.[1] || !match[2]) {
    throw new KmsUnavailableError('BASTION_KMS_KEY for vault must look like transit/keys/<name>');
  }
  return { mount: match[1], name: match[2] };
};

export const createVaultTransitClient = (options: {
  address: string;
  token: string;
  fetch?: FetchLike;
}): RawKmsClient => {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.address.replace(/\/+$/, '');
  const call = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
    const res = await doFetch(`${base}/v1/${path}`, {
      method: 'POST',
      headers: { 'X-Vault-Token': options.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`vault responded ${res.status}`);
    return res.json();
  };
  return {
    async encrypt(keyRef, plaintext, signal) {
      const { mount, name } = parseVaultKey(keyRef);
      const out = vaultEncryptResponse.parse(
        await call(
          `${mount}/encrypt/${name}`,
          { plaintext: Buffer.from(plaintext).toString('base64') },
          signal,
        ),
      );
      return Buffer.from(out.data.ciphertext, 'utf8');
    },
    async decrypt(keyRef, ciphertext, signal) {
      const { mount, name } = parseVaultKey(keyRef);
      const out = vaultDecryptResponse.parse(
        await call(
          `${mount}/decrypt/${name}`,
          { ciphertext: Buffer.from(ciphertext).toString('utf8') },
          signal,
        ),
      );
      return Buffer.from(out.data.plaintext, 'base64');
    },
  };
};

/* ------------------------- lazy cloud SDK adapters ------------------------- */

/** Loads an optional module by name; replaced in tests. Only called when a provider is used. */
export type ModuleLoader = (name: string) => Promise<unknown>;
export const defaultModuleLoader: ModuleLoader = (name) => import(/* @vite-ignore */ name);

type Ctor = new (...args: unknown[]) => unknown;

const exportOf = (mod: unknown, name: string): unknown => {
  if (typeof mod !== 'object' || mod === null) return undefined;
  const direct = Reflect.get(mod, name);
  if (direct !== undefined) return direct;
  const fallback = Reflect.get(mod, 'default');
  return typeof fallback === 'object' && fallback !== null
    ? Reflect.get(fallback, name)
    : undefined;
};

const requireCtor = (mod: unknown, name: string, pkg: string): Ctor => {
  const value = exportOf(mod, name);
  if (typeof value !== 'function') {
    throw new KmsUnavailableError(`${pkg} does not export ${name}; install the package`);
  }
  return value as Ctor;
};

const bytes = (value: unknown, what: string): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  throw new Error(`${what} missing from KMS response`);
};

type Callable = (...args: unknown[]) => Promise<unknown>;
const method = (target: unknown, name: string): Callable => {
  const fn = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined;
  if (typeof fn !== 'function') throw new KmsUnavailableError(`SDK client has no ${name}()`);
  return (...args) => Reflect.apply(fn, target, args) as Promise<unknown>;
};

const memo = <T>(factory: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= factory().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
};

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;

export const createGcpClient = (load: ModuleLoader = defaultModuleLoader): RawKmsClient => {
  const client = memo(async () => {
    const Ctor = requireCtor(
      await load('@google-cloud/kms'),
      'KeyManagementServiceClient',
      '@google-cloud/kms',
    );
    return new Ctor();
  });
  return {
    async encrypt(keyRef, plaintext, signal) {
      const [res] = (await method(await client(), 'encrypt')(
        { name: keyRef, plaintext },
        { signal, timeout: KMS_TIMEOUT_MS },
      )) as unknown[];
      return bytes(field(res, 'ciphertext'), 'ciphertext');
    },
    async decrypt(keyRef, ciphertext, signal) {
      const [res] = (await method(await client(), 'decrypt')(
        { name: keyRef, ciphertext },
        { signal, timeout: KMS_TIMEOUT_MS },
      )) as unknown[];
      return bytes(field(res, 'plaintext'), 'plaintext');
    },
  };
};

export const createAwsClient = (load: ModuleLoader = defaultModuleLoader): RawKmsClient => {
  const sdk = memo(async () => {
    const mod = await load('@aws-sdk/client-kms');
    const Client = requireCtor(mod, 'KMSClient', '@aws-sdk/client-kms');
    return {
      client: new Client(),
      Encrypt: requireCtor(mod, 'EncryptCommand', '@aws-sdk/client-kms'),
      Decrypt: requireCtor(mod, 'DecryptCommand', '@aws-sdk/client-kms'),
    };
  });
  return {
    async encrypt(keyRef, plaintext, signal) {
      const { client, Encrypt } = await sdk();
      const res = await method(client, 'send')(
        new Encrypt({ KeyId: keyRef, Plaintext: plaintext }),
        {
          abortSignal: signal,
        },
      );
      return bytes(field(res, 'CiphertextBlob'), 'CiphertextBlob');
    },
    async decrypt(keyRef, ciphertext, signal) {
      const { client, Decrypt } = await sdk();
      const res = await method(client, 'send')(
        new Decrypt({ KeyId: keyRef, CiphertextBlob: ciphertext }),
        { abortSignal: signal },
      );
      return bytes(field(res, 'Plaintext'), 'Plaintext');
    },
  };
};

const AZURE_ALGORITHM = 'RSA-OAEP-256';

export const createAzureClient = (load: ModuleLoader = defaultModuleLoader): RawKmsClient => {
  const sdk = memo(async () => {
    const keys = await load('@azure/keyvault-keys');
    const identity = await load('@azure/identity');
    const Crypto = requireCtor(keys, 'CryptographyClient', '@azure/keyvault-keys');
    const Credential = requireCtor(identity, 'DefaultAzureCredential', '@azure/identity');
    return { Crypto, credential: new Credential(), clients: new Map<string, unknown>() };
  });
  const cryptoClient = async (keyRef: string): Promise<unknown> => {
    const state = await sdk();
    let client = state.clients.get(keyRef);
    if (!client) {
      client = new state.Crypto(keyRef, state.credential);
      state.clients.set(keyRef, client);
    }
    return client;
  };
  return {
    async encrypt(keyRef, plaintext, signal) {
      const res = await method(await cryptoClient(keyRef), 'wrapKey')(AZURE_ALGORITHM, plaintext, {
        abortSignal: signal,
      });
      return bytes(field(res, 'result'), 'result');
    },
    async decrypt(keyRef, ciphertext, signal) {
      const res = await method(await cryptoClient(keyRef), 'unwrapKey')(
        AZURE_ALGORITHM,
        ciphertext,
        {
          abortSignal: signal,
        },
      );
      return bytes(field(res, 'result'), 'result');
    },
  };
};

/* ------------------------------- factory ------------------------------- */

export type KmsFactoryOptions = {
  env?: Record<string, string | undefined>;
  loader?: ModuleLoader;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Rotation aid for `local`: older 32-byte keys that may still unwrap existing rows. */
  previousLocalKeys?: readonly Buffer[];
};

export const DEFAULT_LOCAL_KEY_PATH = '.bastion/kek.key';

/** Chooses a provider from `BastionConfig` (`kms`, `kmsKey`; 19.1). Cloud SDKs load on first use. */
export const createKmsProvider = (
  config: { kms: 'local' | 'gcp' | 'aws' | 'azure' | 'vault'; kmsKey?: string | undefined },
  options: KmsFactoryOptions = {},
): KmsProvider => {
  const timeout = options.timeoutMs ?? KMS_TIMEOUT_MS;
  const loader = options.loader ?? defaultModuleLoader;
  if (config.kms === 'local') {
    return new LocalKmsProvider(config.kmsKey ?? DEFAULT_LOCAL_KEY_PATH, options.previousLocalKeys);
  }
  const key = config.kmsKey;
  if (!key) throw new KmsUnavailableError(`BASTION_KMS_KEY is required for ${config.kms}`);
  switch (config.kms) {
    case 'gcp':
      return new RemoteKmsProvider('gcp', key, createGcpClient(loader), timeout);
    case 'aws':
      return new RemoteKmsProvider('aws', key, createAwsClient(loader), timeout);
    case 'azure':
      return new RemoteKmsProvider('azure', key, createAzureClient(loader), timeout);
    case 'vault': {
      const env = options.env ?? process.env;
      const address = env.VAULT_ADDR;
      const token = env.VAULT_TOKEN;
      if (!address || !token) {
        throw new KmsUnavailableError('VAULT_ADDR and VAULT_TOKEN are required for the vault KMS');
      }
      parseVaultKey(key);
      const client = createVaultTransitClient({
        address,
        token,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return new RemoteKmsProvider('vault', key, client, timeout);
    }
  }
};
