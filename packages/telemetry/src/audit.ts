/** Audit log export helpers (15.6): CSV, OTLP log attributes for `bastion.audit`, webhook signing. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuditRow {
  seq?: number | undefined;
  id: string;
  ts: Date;
  actorType: string;
  actorId?: string | null | undefined;
  action: string;
  targetType: string;
  targetId?: string | null | undefined;
  diff?: unknown;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  requestId?: string | null | undefined;
  hash?: string | null | undefined;
}

export const AUDIT_CSV_COLUMNS = [
  'seq',
  'id',
  'ts',
  'actor_type',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'diff',
  'ip',
  'user_agent',
  'request_id',
  'hash',
] as const;

/** Prefix cells that a spreadsheet would execute as a formula (CSV injection). */
const neutralize = (value: string): string => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const csvCell = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? neutralize(value)
        : typeof value === 'object'
          ? neutralize(JSON.stringify(value))
          : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** RFC 4180 CSV with a header row and CRLF line endings. */
export const toAuditCsv = (rows: readonly AuditRow[]): string => {
  const lines: string[] = [AUDIT_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.seq,
        r.id,
        r.ts,
        r.actorType,
        r.actorId,
        r.action,
        r.targetType,
        r.targetId,
        r.diff,
        r.ip,
        r.userAgent,
        r.requestId,
        r.hash,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
};

export const AUDIT_LOG_STREAM = 'bastion.audit';

export interface AuditOtlpLog {
  timestamp: Date;
  severityText: 'INFO';
  severityNumber: 9;
  body: string;
  attributes: Record<string, string | number | boolean>;
}

/** Map an audit row to an OTLP log record for the `bastion.audit` stream (15.6). */
export const toAuditOtlpLog = (row: AuditRow): AuditOtlpLog => {
  const attributes: Record<string, string | number | boolean> = {
    'event.name': AUDIT_LOG_STREAM,
    'bastion.audit.id': row.id,
    'bastion.audit.actor.type': row.actorType,
    'bastion.audit.action': row.action,
    'bastion.audit.target.type': row.targetType,
  };
  const optional: [string, string | number | null | undefined][] = [
    ['bastion.audit.seq', row.seq],
    ['bastion.audit.actor.id', row.actorId],
    ['bastion.audit.target.id', row.targetId],
    ['client.address', row.ip],
    ['user_agent.original', row.userAgent],
    ['bastion.audit.request_id', row.requestId],
    ['bastion.audit.hash', row.hash],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== null) attributes[key] = value;
  }
  if (row.diff !== undefined && row.diff !== null) {
    attributes['bastion.audit.diff'] = JSON.stringify(row.diff);
  }
  return {
    timestamp: row.ts,
    severityText: 'INFO',
    severityNumber: 9,
    body: `${row.action} ${row.targetType}${row.targetId ? ` ${row.targetId}` : ''}`,
    attributes,
  };
};

/** Header value for the SIEM webhook (`X-Bastion-Signature`): `sha256=<hex HMAC-SHA256 of the body>`. */
export const signWebhookBody = (secret: string, body: string | Uint8Array): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** Constant-time verification of a header produced by `signWebhookBody`. */
export const verifyWebhookSignature = (
  secret: string,
  body: string | Uint8Array,
  header: string,
): boolean => {
  const expected = Buffer.from(signWebhookBody(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
