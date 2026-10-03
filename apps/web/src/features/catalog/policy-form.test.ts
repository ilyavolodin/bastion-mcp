import { describe, expect, it } from 'vitest';
import type { AutoInstallView, TargetChip } from '@/api/views/catalog';
import {
  emptyPolicyForm,
  formOf,
  type PolicyForm,
  policyError,
  TARGET_ROLES,
  toPolicyCreateBody,
  toPolicyPatchBody,
} from './policy-form';

const chip = (type: TargetChip['type'], id: string): TargetChip => ({ type, id, label: id });
const form = (patch: Partial<PolicyForm> = {}): PolicyForm => ({
  ...emptyPolicyForm('entry-1'),
  targets: [chip('all', 'all')],
  ...patch,
});

describe('auto-install policy form (11.5)', () => {
  it('starts as a default, user-scoped, enabled policy that also reaches existing people', () => {
    expect(emptyPolicyForm('e1')).toEqual({
      entryId: 'e1',
      targets: [],
      mode: 'default',
      applyToExisting: true,
      scope: 'user',
      enabled: true,
    });
    expect(emptyPolicyForm().entryId).toBe('');
  });

  it('names the org roles and manager as audiences', () => {
    expect(TARGET_ROLES).toContain('manager');
    expect(TARGET_ROLES).toContain('admin');
  });

  it('reads a stored policy back into the form', () => {
    const view = {
      id: 'p1',
      catalogEntryId: 'e9',
      targets: [chip('team', 't1')],
      mode: 'required',
      applyToExisting: false,
      scope: 'team',
      enabled: false,
    } as unknown as AutoInstallView;
    expect(formOf(view)).toEqual({
      entryId: 'e9',
      targets: [chip('team', 't1')],
      mode: 'required',
      applyToExisting: false,
      scope: 'team',
      enabled: false,
    });
  });

  it('asks for the entry first, then for a target', () => {
    expect(policyError(form({ entryId: '' }))).toBe('Pick the entry to install');
    expect(policyError(form({ targets: [] }))).toBe('Pick at least one target');
    expect(policyError(form())).toBeUndefined();
  });

  it('caps teams at 200 and IdP group names at 256 characters', () => {
    const teams = Array.from({ length: 201 }, (_, i) => chip('team', `t${i}`));
    expect(policyError(form({ targets: teams }))).toBe('At most 200 teams');
    expect(policyError(form({ targets: teams.slice(0, 200) }))).toBeUndefined();
    expect(policyError(form({ targets: [chip('idpGroup', 'g'.repeat(257))] }))).toBe(
      'IdP group names are limited to 256 characters',
    );
    expect(policyError(form({ targets: [chip('idpGroup', 'g'.repeat(256))] }))).toBeUndefined();
  });

  it('builds the create body with the entry and the audience grouped by kind', () => {
    const f = form({
      targets: [
        chip('team', 't1'),
        chip('role', 'manager'),
        chip('idpGroup', 'eng'),
        chip('team', 't2'),
      ],
      mode: 'required',
      scope: 'team',
      applyToExisting: false,
      enabled: false,
    });
    expect(toPolicyCreateBody(f)).toEqual({
      catalogEntryId: 'entry-1',
      target: { teamIds: ['t1', 't2'], roles: ['manager'], idpGroups: ['eng'] },
      mode: 'required',
      scope: 'team',
      applyToExisting: false,
      enabled: false,
    });
  });

  it('the patch body has the same fields without the entry (it cannot change)', () => {
    const body = toPolicyPatchBody(form());
    expect(body).toEqual({
      target: { all: true },
      mode: 'default',
      scope: 'user',
      applyToExisting: true,
      enabled: true,
    });
    expect('catalogEntryId' in body).toBe(false);
  });
});
