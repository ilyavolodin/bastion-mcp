import type { InstallationInfo } from '@bastion-mcp/router';
import { describe, expect, it } from 'vitest';
import { installationDataOf } from '../src/operations/support';

const info = (owner: InstallationInfo['owner'], policy?: InstallationInfo['policy']) =>
  ({
    id: 'inst-1',
    catalogEntryId: 'cat-1',
    owner,
    ...(policy ? { policy } : {}),
  }) as InstallationInfo;

describe('10.4 installation data for Cedar', () => {
  it('maps a user owner', () => {
    expect(installationDataOf(info({ kind: 'user', id: 'u1' }))).toEqual({
      id: 'inst-1',
      catalogEntryId: 'cat-1',
      ownerUserId: 'u1',
    });
  });

  it('maps a team owner', () => {
    expect(installationDataOf(info({ kind: 'team', id: 't1' }))).toEqual({
      id: 'inst-1',
      catalogEntryId: 'cat-1',
      ownerTeamId: 't1',
    });
  });

  it('maps a service owner with and without its team', () => {
    expect(installationDataOf(info({ kind: 'service', id: 's1' }))).toEqual({
      id: 'inst-1',
      catalogEntryId: 'cat-1',
      ownerServiceId: 's1',
    });
    expect(installationDataOf(info({ kind: 'service', id: 's1', teamId: 't9' }))).toEqual({
      id: 'inst-1',
      catalogEntryId: 'cat-1',
      ownerServiceId: 's1',
      ownerServiceTeamId: 't9',
    });
  });

  it('uses the stored policy data as it is when present', () => {
    const policy = { id: 'p', catalogEntryId: 'c', ownerUserId: 'x' };
    expect(installationDataOf(info({ kind: 'team', id: 't1' }, policy))).toBe(policy);
  });
});
