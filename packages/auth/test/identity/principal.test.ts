import { describe, expect, it } from 'vitest';
import { buildPrincipal, endpointAllowed, hasScope, isManagerOf } from '../../src/identity';
import { memberRecord } from './helpers';

describe('9.3 / 10.1 principal', () => {
  const record = memberRecord('u1', {
    orgRole: 'auditor',
    teams: [
      { teamId: 't1', role: 'manager' },
      { teamId: 't2', role: 'member' },
    ],
  });

  it('9.3 builds a principal from the cached record and credential context', () => {
    const p = buildPrincipal(record, { authMethod: 'pat', scopes: ['mcp'], credentialId: 'pat-1' });
    expect(p).toEqual({
      id: 'u1',
      type: 'user',
      orgRole: 'auditor',
      teams: record.teams,
      active: true,
      authMethod: 'pat',
      clientId: null,
      scopes: ['mcp'],
      endpointRestriction: null,
      credentialId: 'pat-1',
    });
  });

  it('9.3 does not alias the cached record or scope arrays', () => {
    const scopes = ['mcp'];
    const p = buildPrincipal(record, { authMethod: 'oauth', clientId: 'c', scopes });
    scopes.push('api:write');
    expect(p.scopes).toEqual(['mcp']);
    expect(p.teams).not.toBe(record.teams);
  });

  it('10.1 scope, manager and endpoint helpers', () => {
    const p = buildPrincipal(record, {
      authMethod: 'pat',
      scopes: ['mcp'],
      endpointRestriction: 'e1',
    });
    expect(hasScope(p, 'mcp')).toBe(true);
    expect(hasScope(p, 'api:read')).toBe(false);
    expect(isManagerOf(p, 't1')).toBe(true);
    expect(isManagerOf(p, 't2')).toBe(false);
    expect(endpointAllowed(p, 'e1')).toBe(true);
    expect(endpointAllowed(p, 'e2')).toBe(false);
    expect(endpointAllowed({ endpointRestriction: null }, 'any')).toBe(true);
  });
});
