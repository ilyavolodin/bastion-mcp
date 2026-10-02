import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_CSV_COLUMNS,
  type AuditRow,
  HealthRegistry,
  signWebhookBody,
  toAuditCsv,
  toAuditOtlpLog,
  verifyWebhookSignature,
} from '../src';

const audit = (over: Partial<AuditRow> = {}): AuditRow => ({
  seq: 7,
  id: '44444444-4444-4444-8444-444444444444',
  ts: new Date('2026-05-01T10:00:00Z'),
  actorType: 'user',
  actorId: '55555555-5555-4555-8555-555555555555',
  action: 'installation.create',
  targetType: 'installation',
  targetId: 'abc',
  diff: { after: { name: 'x' } },
  ip: '10.0.0.1',
  userAgent: 'curl/8',
  requestId: 'req-1',
  hash: 'deadbeef',
  ...over,
});

describe('15.6 audit export', () => {
  it('15.6 writes a CSV with a header row and one line per event', () => {
    const csv = toAuditCsv([audit(), audit({ seq: 8 })]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(AUDIT_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('2026-05-01T10:00:00.000Z');
    expect(lines[1]).toContain('"{""after"":{""name"":""x""}}"');
  });

  it('15.6 quotes commas, quotes and newlines and neutralizes spreadsheet formulas', () => {
    const csv = toAuditCsv([
      audit({
        userAgent: 'a,"b"\nc',
        action: '=HYPERLINK("x")',
        ip: null,
        targetId: undefined,
        seq: undefined,
      }),
    ]);
    expect(csv).toContain('"a,""b""\nc"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('15.6 maps an audit row to a bastion.audit OTLP log record', () => {
    const log = toAuditOtlpLog(audit());
    expect(log.attributes['event.name']).toBe('bastion.audit');
    expect(log.attributes['bastion.audit.action']).toBe('installation.create');
    expect(log.attributes['bastion.audit.actor.id']).toBe('55555555-5555-4555-8555-555555555555');
    expect(log.attributes['client.address']).toBe('10.0.0.1');
    expect(log.attributes['bastion.audit.diff']).toBe('{"after":{"name":"x"}}');
    expect(log.timestamp).toEqual(new Date('2026-05-01T10:00:00Z'));
    expect(log.body).toBe('installation.create installation abc');
    const sparse = toAuditOtlpLog(
      audit({ ip: null, diff: null, targetId: null, userAgent: undefined }),
    );
    expect(sparse.attributes).not.toHaveProperty('client.address');
    expect(sparse.attributes).not.toHaveProperty('bastion.audit.diff');
    expect(sparse.body).toBe('installation.create installation');
  });

  it('15.6 signs the webhook body with HMAC-SHA256', () => {
    // RFC 4231 test case 2
    expect(signWebhookBody('Jefe', 'what do ya want for nothing?')).toBe(
      'sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(signWebhookBody('Jefe', new TextEncoder().encode('what do ya want for nothing?'))).toBe(
      signWebhookBody('Jefe', 'what do ya want for nothing?'),
    );
  });

  it('15.6 verifies webhook signatures in constant time and rejects tampering', () => {
    const header = signWebhookBody('s3cret', '{"a":1}');
    expect(verifyWebhookSignature('s3cret', '{"a":1}', header)).toBe(true);
    expect(verifyWebhookSignature('s3cret', '{"a":2}', header)).toBe(false);
    expect(verifyWebhookSignature('other', '{"a":1}', header)).toBe(false);
    expect(verifyWebhookSignature('s3cret', '{"a":1}', 'short')).toBe(false);
  });
});

describe('15.7 health', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('15.7 liveness reports the process alive without consulting checks', () => {
    const reg = new HealthRegistry();
    reg.register('db', async () => false);
    expect(reg.liveness()).toEqual({ ok: true });
  });

  it('15.7 returns per-check JSON and ok only when every check is ok', async () => {
    const reg = new HealthRegistry();
    reg.register('postgres', async () => ({ ok: true, detail: { latencyMs: 2 } }));
    reg.register('redis', async () => true);
    reg.register('migrations', async () => undefined);
    expect(await reg.run()).toEqual({
      ok: true,
      checks: {
        postgres: { ok: true, detail: { latencyMs: 2 } },
        redis: { ok: true, detail: null },
        migrations: { ok: true, detail: null },
      },
    });
    reg.register('sandbox', async () => ({ ok: false, detail: 'driver unavailable' }));
    const report = await reg.run();
    expect(report.ok).toBe(false);
    expect(report.checks.sandbox).toEqual({ ok: false, detail: 'driver unavailable' });
    expect(report.checks.postgres?.ok).toBe(true);
    expect(reg.names()).toEqual(['postgres', 'redis', 'migrations', 'sandbox']);
  });

  it('15.7 times out a hung check, aborts its signal and reports the others', async () => {
    const reg = new HealthRegistry({ timeoutMs: 1000 });
    let aborted = false;
    reg.register('hung', (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => {});
    });
    reg.register('fast', async () => true);
    reg.register('slow-allowed', () => new Promise((r) => setTimeout(() => r(true), 3000)), {
      timeoutMs: 5000,
    });
    const pending = reg.run();
    await vi.advanceTimersByTimeAsync(3000);
    const report = await pending;
    expect(aborted).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.checks.hung).toEqual({ ok: false, detail: 'timed out after 1000 ms' });
    expect(report.checks.fast?.ok).toBe(true);
    expect(report.checks['slow-allowed']?.ok).toBe(true);
  });

  it('15.7 turns a throwing check into a failed check instead of rejecting', async () => {
    const reg = new HealthRegistry();
    reg.register('boom', async () => {
      throw new Error('connection refused');
    });
    reg.register('weird', async () => {
      throw 'str';
    });
    const report = await reg.run();
    expect(report.checks.boom).toEqual({ ok: false, detail: 'connection refused' });
    expect(report.checks.weird).toEqual({ ok: false, detail: 'str' });
  });

  it('15.7 an empty registry is healthy', async () => {
    expect(await new HealthRegistry().run()).toEqual({ ok: true, checks: {} });
  });
});
