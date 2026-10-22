import { readFileSync, writeFileSync } from 'node:fs';
import { type BastionConfig, ConfigError } from '@bastion-mcp/core';
import { createKmsProvider, type KeyringPurpose } from '@bastion-mcp/secrets';
import { Redis } from 'ioredis';
import pg from 'pg';
import {
  createBackup,
  RestoreRefusedError,
  type RestoreReport,
  readBackup,
  restoreBackup,
} from '../backup/backup';
import { createMaintenance } from '../backup/maintenance';
import { BackupFileError } from '../backup/sealed-file';
import { bootstrapAdminUser } from '../boot/bootstrap-admin';
import { migrate, migrationStatus } from '../boot/migrate';
import { resetPassword } from '../boot/reset-password';
import { setRole } from '../boot/set-role';
import { loadServerConfig } from '../config';
import { createInfra, type Infra } from '../infra';
import { KEY_PURPOSES, publishKeyChange, rotateKeys } from '../scheduler/tasks/keys';
import { CLI_CONNECT_TIMEOUT_MS } from '../timing';
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
  'set-role',
  'rotate-keys',
  'export-config',
  'import-config',
  'backup',
  'restore',
  'maintenance',
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

const VALUE_FLAGS = new Set(['email', 'purpose', 'file', 'out', 'role', 'mode']);

export const HELP = `bastion: self-hosted MCP gateway

Usage: bastion [command] [options]

Commands:
  serve                      Run the server (default; BASTION_ROLE = worker | ui | all)
  migrate                    Apply pending database migrations
  check-config               Validate the environment and connectivity (Postgres, Redis, KMS, migrations)
  create-admin --email <e>   Create a local admin (generated password printed once; --password-stdin to supply one)
  reset-password --email <e> Set a new password for a local account (generated and printed once; --password-stdin
                             to supply one). Signs the account out everywhere and revokes its tokens
  set-role --email <e> --role <r>
                             Give an existing account the organization role admin | auditor | member (for example to
                             make an identity provider account an administrator when nobody can sign in as one)
  rotate-keys --purpose <p>  Rotate keys: as | state | upstream-client (--force creates a new key even if none is due)
  export-config [--out f]    Export catalog, policies, settings, guard profiles, limit rules, registry sources,
                             marketplaces as JSON (secrets are never exported)
  import-config [--file f]   Import such a JSON (stdin by default; --dry-run validates only)
  backup --out <f>           Full encrypted backup: configuration, catalog, users, teams, installations and per-user
                             settings, OAuth connections, token hashes, audit log and every secret. The passphrase
                             comes from BASTION_BACKUP_PASSPHRASE or the first line of stdin (--passphrase-stdin)
  restore --file <f>         Restore a backup. --mode merge (default) upserts by id (an existing row with the same email or slug but another id is replaced); --mode replace
                             swaps every backed-up table and needs maintenance mode. --dry-run shows what would change
  maintenance on|off|status  Stop (or resume) gateway and OAuth traffic on every replica
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

const passphraseOf = async (p: Parsed, env: Env, io: Io): Promise<string | undefined> => {
  const fromStdin = p.flags.has('passphrase-stdin')
    ? (await io.stdin()).split(/\r?\n/)[0]
    : undefined;
  const value = fromStdin ?? env.BASTION_BACKUP_PASSPHRASE;
  if (!value)
    io.err('a passphrase is required: set BASTION_BACKUP_PASSPHRASE or use --passphrase-stdin');
  return value || undefined;
};

const formatRestoreReport = (report: RestoreReport): string => {
  const rows = Object.entries(report.tables).map(
    ([name, t]) =>
      `${name.padEnd(26)} ${String(t.rows).padStart(7)} in backup ${String(t.existing).padStart(7)} ${
        report.mode === 'merge' ? 'already here' : 'here now (removed)'
      }${t.action === 'skip' ? `  [skipped: ${t.note}]` : ''}`,
  );
  return rows.join('\n');
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
    connectionTimeoutMillis: CLI_CONNECT_TIMEOUT_MS,
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
    connectTimeout: CLI_CONNECT_TIMEOUT_MS,
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
      case 'set-role': {
        const email = flagString(parsed, 'email');
        const role = flagString(parsed, 'role');
        if (!email || !role) {
          io.err('set-role requires --email <address> and --role admin | auditor | member');
          return 2;
        }
        return await withInfra(env, async (infra) => {
          const result = await setRole(infra, { email, role });
          if (!result.ok) {
            io.err(
              result.reason === 'invalid_role'
                ? 'the role must be admin, auditor or member'
                : result.reason === 'not_found'
                  ? `no account with the email ${email} (it is created when the person first signs in)`
                  : result.reason === 'deactivated'
                    ? `${email} is deactivated`
                    : 'this is the last active administrator: make somebody else an administrator first',
            );
            return 1;
          }
          io.out(
            result.from === result.to
              ? `${result.email} already is ${result.to}`
              : `${result.email} is now ${result.to} (was ${result.from})`,
          );
          if (result.ruleManaged) {
            io.out(
              'note: IdP group mapping rules also set roles, at every sign-in; a role they set replaces this one',
            );
          }
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
      case 'backup': {
        const out = flagString(parsed, 'out');
        if (!out) {
          io.err('backup: --out <file> is required');
          return 2;
        }
        const passphrase = await passphraseOf(parsed, env, io);
        if (!passphrase) return 2;
        return await withInfra(env, async (infra) => {
          const report = await createBackup(infra, passphrase, { id: null });
          writeFileSync(out, report.file, { mode: 0o600 });
          io.out(`backup written to ${out} (${report.file.length} bytes)`);
          io.out(`rows: ${JSON.stringify(report.counts)}`);
          io.out('Keep the passphrase and the file apart. The file contains every secret.');
          return 0;
        });
      }
      case 'restore': {
        const file = flagString(parsed, 'file');
        if (!file) {
          io.err('restore: --file <backup> is required');
          return 2;
        }
        const mode = flagString(parsed, 'mode') ?? 'merge';
        if (mode !== 'merge' && mode !== 'replace') {
          io.err('restore: --mode must be merge or replace');
          return 2;
        }
        const passphrase = await passphraseOf(parsed, env, io);
        if (!passphrase) return 2;
        return await withInfra(env, async (infra) => {
          try {
            const { document } = await readBackup(readFileSync(file), passphrase);
            const report = await restoreBackup(infra, createMaintenance(infra.redis), document, {
              mode,
              dryRun: parsed.flags.has('dry-run'),
            });
            io.out(
              `${report.dryRun ? 'would restore' : 'restored'} (${mode}) backup from ${report.backup.createdAt}`,
            );
            io.out(formatRestoreReport(report));
            for (const warning of report.warnings) io.out(`warning: ${warning}`);
            if (!report.dryRun && mode === 'replace') {
              io.out(
                'Maintenance mode is still on. Check the instance, then run: bastion maintenance off',
              );
            }
            return 0;
          } catch (error) {
            if (error instanceof RestoreRefusedError || error instanceof BackupFileError) {
              io.err(`restore refused: ${error.message}`);
              return 1;
            }
            throw error;
          }
        });
      }
      case 'maintenance': {
        const action = parsed.positional[0];
        if (action !== 'on' && action !== 'off' && action !== 'status') {
          io.err('maintenance: expected on, off or status');
          return 2;
        }
        return await withInfra(env, async (infra) => {
          const maintenance = createMaintenance(infra.redis);
          const state =
            action === 'status'
              ? await maintenance.get()
              : await maintenance.set(action === 'on', 'cli');
          io.out(
            state.enabled
              ? `maintenance mode is ON since ${state.since} (by ${state.by})`
              : 'maintenance mode is off',
          );
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
