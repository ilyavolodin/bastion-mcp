import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/api/schema';
import {
  reasonsText,
  serverKey,
  toRequestView,
  toServerView,
  withVisibility,
} from '@/api/views/registry';
import { rejectFormSchema, requestFormSchema, requestToBody } from '@/features/registry/forms';

const server: Schemas['RegistryServer'] = {
  sourceId: 's1',
  name: 'dev.acme/ledger',
  version: '1.2.0',
  status: 'active',
  isLatest: true,
  description: 'Ledger',
  runtimes: ['pypi'],
};

describe('registry views (11.7)', () => {
  it('joins the source name and flags a server the caller already asked for', () => {
    const open = (serverName: string, version: string) => ({
      sourceId: 's1',
      serverName,
      version,
      status: 'open' as const,
      requesterId: 'u1',
    });
    const ctx = {
      sourceNames: new Map([['s1', 'Acme internal registry']]),
      meId: 'u1',
      openRequests: [open('dev.acme/ledger', '1.2.0'), open('dev.acme/other', '1.0.0')],
    };
    expect(toServerView(server, ctx)).toMatchObject({
      sourceName: 'Acme internal registry',
      requested: true,
    });
    expect(toServerView({ ...server, version: '1.3.0' }, ctx).requested).toBe(false);
    expect(toServerView(server, { ...ctx, meId: 'u2' }).requested).toBe(false);
    expect(toServerView(server, { ...ctx, sourceNames: new Map() }).sourceName).toBe('s1');
  });

  it('names the requester and the team, and reads the justification as the reason', () => {
    const view = toRequestView(
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        requesterId: 'u1',
        sourceId: 's1',
        serverName: 'dev.acme/ledger',
        version: '1.2.0',
        justification: 'Close the books',
        status: 'open',
        decidedBy: null,
        decidedAt: null,
        reason: null,
      },
      {
        requesters: new Map([['u1', { name: 'Raj Mehta', teams: ['Data platform'] }]]),
        sourceNames: new Map([['s1', 'Acme']]),
      },
    );
    expect(view).toMatchObject({
      requesterName: 'Raj Mehta',
      teamName: 'Data platform',
      sourceName: 'Acme',
      reason: 'Close the books',
    });
  });

  it('keys a server by source, name and version and phrases the policy reasons', () => {
    expect(serverKey(server)).toBe('s1/dev.acme/ledger@1.2.0');
    expect(reasonsText(['a', 'b'])).toBe('a. b');
    expect(reasonsText([])).toMatch(/policy/);
  });

  it('mirrors the request constraints of the API in the forms', () => {
    expect(requestFormSchema.safeParse({ justification: '   ' }).success).toBe(false);
    expect(requestFormSchema.safeParse({ justification: 'x'.repeat(2001) }).success).toBe(false);
    expect(rejectFormSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(requestToBody(server, { justification: 'ok' })).toEqual({
      sourceId: 's1',
      name: 'dev.acme/ledger',
      version: '1.2.0',
      justification: 'ok',
    });
  });
});

describe('withVisibility: showing and hiding a server from members through the policy lists', () => {
  const policy = { allowedNamespaces: ['*'], blockedNamespaces: ['x/old'], mode: 'request' };

  it('hiding blocks the exact name once and changes nothing else', () => {
    const hidden = withVisibility(policy, 'dev.acme/ledger', false);
    expect(hidden).toEqual({ ...policy, blockedNamespaces: ['x/old', 'dev.acme/ledger'] });
    expect(withVisibility(hidden, 'dev.acme/ledger', false).blockedNamespaces).toEqual([
      'x/old',
      'dev.acme/ledger',
    ]);
  });

  it('showing takes the name off the blocked list, and adds it to the allowed names when the policy allows only some', () => {
    const everything = withVisibility(
      { ...policy, blockedNamespaces: ['dev.acme/ledger'] },
      'dev.acme/ledger',
      true,
    );
    expect(everything.blockedNamespaces).toEqual([]);
    expect(everything.allowedNamespaces).toEqual(['*']);

    const only = withVisibility(
      { ...policy, allowedNamespaces: ['io.github.acme/*'], blockedNamespaces: [] },
      'dev.acme/ledger',
      true,
    );
    expect(only.allowedNamespaces).toEqual(['io.github.acme/*', 'dev.acme/ledger']);
  });
});
