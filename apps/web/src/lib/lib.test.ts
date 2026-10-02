import { describe, expect, it } from 'vitest';
import { sparkPoints } from '@/components/sparkline';
import { importSnippet } from '../features/catalog/import-snippet';
import { diffLines, diffWords, stableStringify } from './diff';
import {
  formatDuration,
  formatRelative,
  formatUptime,
  initials,
  installationAction,
  percent,
} from './format';
import { isExecutablePath, parseSkill, serializeSkill, validateFrontmatter } from './frontmatter';
import { emptyOverrides, setToolField, validateOverrideText } from './override-schema';
import { canSee, uiRole, visibleSections } from './roles';

const me = (orgRole: 'admin' | 'auditor' | 'member', manager = false) => ({
  orgRole,
  teams: [
    { id: 't', name: 'Platform', role: manager ? ('manager' as const) : ('member' as const) },
  ],
});

describe('roles (10.1, 18.2)', () => {
  it('10.1 a member who manages a team is a Manager', () => {
    expect(uiRole(me('member', true))).toBe('manager');
    expect(uiRole(me('member'))).toBe('member');
    expect(uiRole(me('admin', true))).toBe('admin');
    expect(uiRole(me('auditor'))).toBe('auditor');
  });
  it('18.2 filters the navigation by role', () => {
    expect(visibleSections('member')).toEqual([
      'home',
      'store',
      'servers',
      'activity',
      'plugins',
      'registry',
    ]);
    expect(visibleSections('auditor')).toContain('observability');
    expect(visibleSections('auditor')).not.toContain('registry');
    expect(canSee('settings', 'manager')).toBe(false);
    expect(canSee('settings', 'admin')).toBe(true);
    expect(canSee('catalog', 'manager')).toBe(true);
  });
  it('18.2 the registry also depends on registry policy', () => {
    expect(canSee('registry', 'member', { registry: false })).toBe(false);
    expect(canSee('registry', 'member', { registry: true })).toBe(true);
  });
});

describe('format', () => {
  it('formats durations, uptime and relative time', () => {
    expect(formatDuration(900)).toBe('900 ms');
    expect(formatDuration(2300)).toBe('2.3 s');
    expect(formatDuration(30_000)).toBe('30 s');
    expect(formatUptime(6 * 86400)).toBe('6 d');
    expect(formatUptime(18 * 60)).toBe('18 min');
    const now = Date.now();
    expect(formatRelative(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe('2 h ago');
    expect(formatRelative(new Date(now - 86_400_000).toISOString(), now)).toBe('yesterday');
  });
  it('initials and percent', () => {
    expect(initials('Dana Whitfield')).toBe('DW');
    expect(percent(25, 100)).toBe(25);
    expect(percent(5, 0)).toBe(0);
  });
  it('18.1 names one next action per installation state', () => {
    expect(
      installationAction({ status: 'needs_setup', authMode: 'oauth', displayName: 'GitHub' })
        ?.label,
    ).toBe('Connect GitHub');
    expect(
      installationAction({ status: 'needs_setup', authMode: 'userSecret', displayName: 'Notion' })
        ?.label,
    ).toBe('Add API key');
    expect(
      installationAction({ status: 'reconnect_required', authMode: 'oauth', displayName: 'Sentry' })
        ?.label,
    ).toBe('Reconnect Sentry');
    expect(
      installationAction({ status: 'error', authMode: 'none', displayName: 'FS' })?.label,
    ).toBe('See why');
    expect(
      installationAction({ status: 'ready', authMode: 'oauth', displayName: 'Jira' }),
    ).toBeNull();
  });
});

describe('diff (12.5, 13.6)', () => {
  it('marks only the inserted words', () => {
    const ops = diffWords('Fetch an event by ID.', 'Fetch an event by ID. Also call slack.');
    expect(
      ops
        .filter((o) => o.type === 'add')
        .map((o) => o.text.trim())
        .join(' '),
    ).toContain('Also call slack.');
    expect(ops.some((o) => o.type === 'del')).toBe(false);
  });
  it('pairs removed and added lines as changed rows', () => {
    const rows = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(rows.map((r) => r.kind)).toEqual(['equal', 'changed', 'equal', 'added']);
  });
  it('stableStringify sorts keys', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(
      stableStringify({ a: { c: 2, d: 1 }, b: 1 }),
    );
  });
});

describe('override document (12.2)', () => {
  it('accepts a valid document and rejects unknown keys and bad names', () => {
    expect(validateOverrideText('{"version":1,"tools":{"a":{"hidden":true}}}').ok).toBe(true);
    const bad = validateOverrideText('{"version":1,"tools":{"a":{"name":"has space"}}}');
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]?.path).toBe('tools.a.name');
    expect(validateOverrideText('{"version":2}').ok).toBe(false);
    expect(validateOverrideText('{nope').ok).toBe(false);
  });
  it('setToolField writes and clears fields, dropping empty entries', () => {
    let doc = setToolField(emptyOverrides(), 'x', 'hidden', true);
    expect(doc.tools).toEqual({ x: { hidden: true } });
    doc = setToolField(doc, 'x', 'hidden', undefined);
    expect(doc.tools).toBeUndefined();
  });
});

describe('SKILL.md frontmatter (25.2)', () => {
  const src =
    '---\nname: triage\ndescription: Triage incidents\nallowed-tools: Read\n---\n# Body\n';
  it('keeps unknown keys verbatim through a round trip', () => {
    const p = parseSkill(src);
    expect(p.frontmatter.extra).toEqual({ 'allowed-tools': 'Read' });
    expect(parseSkill(serializeSkill(p.frontmatter, p.body)).frontmatter).toEqual(p.frontmatter);
  });
  it('reports missing frontmatter and invalid fields', () => {
    expect(parseSkill('# no fence').error).toBeTruthy();
    expect(validateFrontmatter({ name: 'Bad Name', description: '', extra: {} })).toEqual({
      name: expect.any(String),
      description: expect.any(String),
    });
  });
  it('flags executable paths', () => {
    expect(isExecutablePath('hooks/post-tool.sh')).toBe(true);
    expect(isExecutablePath('references/runbook.md')).toBe(false);
  });
});

describe('catalog import (11.3)', () => {
  it('maps npx to npm with an exact version and uvx to python', () => {
    expect(importSnippet('{"command":"npx","args":["-y","@acme/pg-mcp@3.2.0"]}')).toMatchObject({
      runtime: 'npm',
      package: '@acme/pg-mcp',
      version: '3.2.0',
    });
    expect(
      importSnippet('{"mcpServers":{"x":{"command":"uvx","args":["mcp-server-fetch"]}}}'),
    ).toMatchObject({ runtime: 'python', package: 'mcp-server-fetch' });
    expect(importSnippet('{"url":"https://mcp.example.com"}')).toMatchObject({ runtime: 'remote' });
    expect(importSnippet('{"command":"bash"}')).toHaveProperty('error');
    expect(importSnippet('nope')).toHaveProperty('error');
  });
});

describe('sparkline', () => {
  it('scales points into the box', () => {
    const pts = sparkPoints([0, 10], 200, 36).split(' ');
    expect(pts[0]).toBe('0.0,34.0');
    expect(pts[1]).toBe('200.0,2.0');
    expect(sparkPoints([])).toBe('');
  });
});
