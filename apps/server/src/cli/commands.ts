import { readFileSync, writeFileSync } from 'node:fs';
import { type BastionConfig, ConfigError } from '@bastion-mcp/core';
import { createKmsProvider, type KeyringPurpose } from '@bastion-mcp/secrets';
import { Redis } from 'ioredis';
import pg from 'pg';
import { bootstrapAdminUser } from '../boot/bootstrap-admin';
import { migrate, migrationStatus } from '../boot/migrate';
import { resetPassword } from '../boot/reset-password';
import { loadServerConfig } from '../config';
import { createInfra, type Infra } from '../infra';
import { KEY_PURPOSES, publishKeyChange, rotateKeys } from '../scheduler/tasks/keys';
import { exportConfig, importConfig } from './config-io';

export type Env = Record<string, string | undefined>;
export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads all of stdin (for `--password-stdin` and `import-config` without `--file`). */
  stdin: () => Promise<string>;
};

export type Parsed = { command: string; flags: Map<string, string | true>; positional: string[] };

export const COMMANDS = [
  'serve',
  'migrate',
  'check-config',
  'create-admin',
  'reset-password',
  'rotate-keys',
  'export-config',
  'import-config',
  'help',
] as const;

export const parseArgs = (argv: readonly string[]): Parsed => {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h') flags.set('help', true);
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--') && VALUE_FLAGS.has(arg.slice(2))) {
          flags.set(arg.slice(2), next);
          i += 1;
        } else flags.set(arg.slice(2), true);
      }
    } else positional.push(arg);
  }
  return { command: positional[0] ?? 'serve', flags, positional: positional.slice(1) };
};

const VALUE_FLAGS = new Set(['email', 'purpose', 'file', 'out']);

export const HELP = `bastion: self-hosted MCP gateway

Usage: bastion [command] [options]

Commands:
  serve                      Run the server (default; BASTION_ROLE = worker | ui | all)
  migrate                    Apply pending database migrations
  check-config               Validate the environment and connectivity (Postgres, Redis, KMS, migrations)
  create-admin --email <e>   Create a local admin (generated password printed once; --password-stdin to supply one)
  reset-password --email <e> Set a new password for a local account (generated and printed once; --password-stdin
                             to supply one). Signs the account out everywhere and revokes its tokens
  rotate-keys --purpose <p>  Rotate keys: as | state | upstream-client (--force creates a new key even if none is due)
  export-config [--out f]    Export catalog, policies, settings, guard profiles, limit rules, registry sources,
                             marketplaces as JSON (secrets are never exported)
  import-config [--file f]   Import such a JSON (stdin by default; --dry-run validates only)
`;

const flagString = (p: Parsed, name: string): string | undefined => {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

export const isPurpose = (v: string | undefined): v is KeyringPurpose =>
  v !== undefined && (KEY_PURPOSES as readonly string[]).includes(v);

const withInfra = async <T>(
  env: Env,
  fn: (infra: Infra, config: BastionConfig) => Promise<T>,
): Promise<T> => {
  const config = loadServerConfig(env);
  const infra = createInfra(config, { skipMigrationCheck: true });
  try {
    return await fn(infra, config);
  } finally {
    await infra.close();
  }
};

export type CheckRow = { check: string; ok: boolean; detail: string };

/** `bastion check-config`: every row is independent, so one failure does not hide the others. */
export const checkConfig = async (env: Env): Promise<CheckRow[]> => {
  const rows: CheckRow[] = [];
  let config: BastionConfig;
  try {
    config = loadServerConfig(env);
    rows.push({
      check: 'configuration',
      ok: true,
      detail: `role=${config.role} url=${config.publicUrl}`,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const issue of error.issues) {
        rows.push({ check: `config ${issue.path}`, ok: false, detail: issue.message });
      }
    } else {
      rows.push({
        check: 'configuration',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return rows;
  }

  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const v = await client.query('SHOW server_version');
    rows.push({ check: 'postgres', ok: true, detail: `version ${v.rows[0]?.server_version}` });
    const status = await migrationStatus(client);
    const pending = [...status.pending, ...status.failed];
    rows.push({
      check: 'migrations',
      ok: pending.length === 0,
      detail:
        pending.length === 0
          ? `${status.applied.length} applied`
          : `pending: ${pending.join(', ')}`,
    });
  } catch (error) {
    rows.push({
      check: 'postgres',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.end().catch(() => undefined);
  }

  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    const pong = await redis.ping();
    rows.push({ check: 'redis', ok: pong === 'PONG', detail: pong });
  } catch (error) {
    rows.push({
      check: 'redis',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    redis.disconnect();
  }

  try {
    const kms = createKmsProvider({
      kms: config.kms,
      kmsKey: config.kmsKey ?? `${config.dataDir}/kek.key`,
    });
    const health = await kms.health();
    rows.push({ check: `kms (${config.kms})`, ok: health.ok, detail: health.detail ?? kms.kekRef });
  } catch (error) {
    rows.push({
      check: `kms (${config.kms})`,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return rows;
};

export const formatTable = (rows: readonly CheckRow[]): string => {
  const width = Math.max(5, ...rows.map((r) => r.check.length));
  return rows
    .map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.check.padEnd(width)}  ${r.detail}`)
    .join('\n');
};

/** Runs one CLI command; returns the process exit code. `serve` is handled by the caller. */
export const execute = async (argv: readonly string[], env: Env, io: Io): Promise<number> => {
  const parsed = parseArgs(argv);
  if (parsed.flags.has('help') || parsed.command === 'help') {
    io.out(HELP);
    return 0;
  }
  try {
    switch (parsed.command) {
      case 'migrate': {
        const config = loadServerConfig(env);
        const result = await migrate(config.databaseUrl, { log: io.out });
        io.out(
          result.applied.length === 0
            ? `database is up to date (${result.alreadyApplied} migrations applied)`
            : `applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`,
        );
        return 0;
      }
      case 'check-config': {
        const rows = await checkConfig(env);
        io.out(formatTable(rows));
        return rows.every((r) => r.ok) ? 0 : 1;
      }
      case 'create-admin': {
        const email = flagString(parsed, 'email');
        if (!email) {
          io.err('create-admin requires --email <address>');
          return 2;
        }
        const password = parsed.flags.has('password-stdin') ? (await io.stdin()).trim() : undefined;
        return await withInfra(env, async (infra) => {
          const result = await bootstrapAdminUser(
            infra,
            (e, p) => io.out(`admin ${e} created; password (shown once): ${p}`),
            { email, password },
          );
          if (!result.created) {
            io.err(`no admin created: ${email} already exists or is invalid`);
            return 1;
          }
          if (password !== undefined) io.out(`admin ${result.email} created`);
          return 0;
        });
      }
      case 'reset-password': {
        const email = flagString(parsed, 'email');
        if (!email) {
          io.err('reset-password requires --email <address>');
          return 2;
        }
        const password = parsed.flags.has('password-stdin') ? (await io.stdin()).trim() : undefined;
        return await withInfra(env, async (infra) => {
          const result = await resetPassword(infra, { email, password });
          if (!result.ok) {
            io.err(
              result.reason === 'policy'
                ? result.message
                : result.reason === 'not_found'
                  ? `no account with the email ${email}`
                  : `${email} signs in through an identity provider and has no local password`,
            );
            return 1;
          }
          io.out(
            result.generatedPassword === undefined
              ? `password of ${result.email} reset`
              : `password of ${result.email} reset; new password (shown once): ${result.generatedPassword}`,
          );
          io.out('all sessions and tokens of this user were revoked');
          return 0;
        });
      }
      case 'rotate-keys': {
        const purpose = flagString(parsed, 'purpose');
        if (!isPurpose(purpose)) {
          io.err(`rotate-keys requires --purpose ${KEY_PURPOSES.join(' | ')}`);
          return 2;
        }
        return await withInfra(env, async (infra) => {
          const result = await rotateKeys(infra, purpose, { force: parsed.flags.has('force') });
          if (result.created !== undefined || result.retired.length > 0) {
            await publishKeyChange(infra, [purpose]);
          }
          io.out(
            result.created
              ? `${purpose}: created key ${result.created}; retired ${result.retired.length} expired key(s)`
              : `${purpose}: no rotation due (use --force to rotate anyway); retired ${result.retired.length}`,
          );
          return 0;
        });
      }
      case 'export-config': {
        return await withInfra(env, async (infra) => {
          const doc = await exportConfig(infra);
          const text = `${JSON.stringify(doc, null, 2)}\n`;
          const out = flagString(parsed, 'out');
          if (out) {
            writeFileSync(out, text, { mode: 0o600 });
            io.out(`exported ${Object.keys(doc).length - 2} sections to ${out}`);
          } else io.out(text);
          return 0;
        });
      }
      case 'import-config': {
        const file = flagString(parsed, 'file');
        const text = file ? readFileSync(file, 'utf8') : await io.stdin();
        let input: unknown;
        try {
          input = JSON.parse(text);
        } catch {
          io.err('import-config: input is not valid JSON');
          return 2;
        }
        return await withInfra(env, async (infra) => {
          const report = await importConfig(infra, input, { dryRun: parsed.flags.has('dry-run') });
          io.out(`${report.dryRun ? 'validated' : 'imported'}: ${JSON.stringify(report.counts)}`);
          return 0;
        });
      }
      default:
        io.err(`unknown command "${parsed.command}"\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const issue of error.issues) io.err(`config error: ${issue.path}: ${issue.message}`);
      return 1;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
