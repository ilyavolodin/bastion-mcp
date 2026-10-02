import type { AuthzInput, ResourceChoice } from '../framework/route';
import type { ApiDeps, AuditEventView } from '../ports';
import { orgResource, teamResource } from './resources';

/** `GET /audit?team=` shows a team's events to its managers; without a team it needs the org rule (15.6). */
export const auditChoice = (input: AuthzInput): ResourceChoice =>
  input.query.team
    ? { rule: 'audit.team', resource: teamResource(input.query.team) }
    : { rule: 'audit.org', resource: orgResource() };

const COLUMNS = [
  'seq',
  'id',
  'ts',
  'actorType',
  'actorId',
  'action',
  'targetType',
  'targetId',
  'ip',
  'requestId',
  'diff',
] as const;

/**
 * One CSV cell. Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with a quote so a
 * spreadsheet never evaluates them as formulas; fields with commas, quotes or newlines are quoted.
 */
export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const csvRow = (event: AuditEventView): string =>
  COLUMNS.map((column) => csvCell(event[column])).join(',');

export const csvHeader = (): string => COLUMNS.join(',');

export type ExportFormat = 'csv' | 'json';

/** Renders the export in one pass over the reader's stream (15.6). */
export const renderAuditExport = async (
  deps: ApiDeps,
  format: ExportFormat,
  range: { from?: string | undefined; to?: string | undefined },
): Promise<{ body: string; contentType: string; filename: string }> => {
  const parts: string[] = [];
  if (format === 'csv') {
    parts.push(csvHeader());
    for await (const event of deps.observability.audit.all(range)) parts.push(csvRow(event));
    return {
      body: `${parts.join('\r\n')}\r\n`,
      contentType: 'text/csv; charset=utf-8',
      filename: 'audit.csv',
    };
  }
  for await (const event of deps.observability.audit.all(range)) parts.push(JSON.stringify(event));
  return {
    body: `[${parts.join(',')}]`,
    contentType: 'application/json; charset=utf-8',
    filename: 'audit.json',
  };
};
