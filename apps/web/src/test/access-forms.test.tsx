import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * Every Access form is submitted through the real screen; the body that reaches the API is validated against the
 * OpenAPI request schema (ajv) and checked for the values the user typed (10, 17.2).
 */

describe('Access forms send what the API requires (17.2)', () => {
  it('10.1 a new team sends slug and displayName, deriving the slug from the name', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=teams');
    await user.click(await screen.findByRole('button', { name: 'New team' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    await user.type(within(dialog).getByLabelText(/Team name/), 'Data Science!');
    expect(within(dialog).getByLabelText(/URL name/)).toHaveValue('data-science');
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }));
    expect(await expectSent(capture, 'post', '/teams')).toEqual({
      slug: 'data-science',
      displayName: 'Data Science!',
    });
    await waitFor(() =>
      expect(getDb().data.access.teams.some((t) => t.slug === 'data-science')).toBe(true),
    );
    capture.stop();
  });

  it('10.1 an edited URL name stops following the name, and the IdP group is optional', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=teams');
    await user.click(await screen.findByRole('button', { name: 'New team' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    await user.type(within(dialog).getByLabelText(/Team name/), 'Security');
    const url = within(dialog).getByLabelText(/URL name/);
    await user.clear(url);
    await user.type(url, 'sec-ops');
    await user.type(within(dialog).getByLabelText(/Team name/), ' Ops');
    expect(url).toHaveValue('sec-ops');
    await user.type(within(dialog).getByLabelText(/IdP group/), 'eng-security');
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }));
    expect(await expectSent(capture, 'post', '/teams')).toEqual({
      slug: 'sec-ops',
      displayName: 'Security Ops',
      idpGroup: 'eng-security',
    });
    capture.stop();
  });

  it('10.1 a team slug that the API would refuse is not sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=teams');
    await user.click(await screen.findByRole('button', { name: 'New team' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    await user.type(within(dialog).getByLabelText(/Team name/), 'Data');
    const url = within(dialog).getByLabelText(/URL name/);
    await user.clear(url);
    await user.type(url, 'Not A Slug');
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }));
    expect(
      await within(dialog).findByText(/Lowercase letters, digits and dashes, 2 to 40/, {
        selector: 'p[role="alert"]',
      }),
    ).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/teams'))).toBe(false);
    capture.stop();
  });

  it('9.4 a service account sends team, slug, name and auth method and shows the secret once', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=service');
    await user.click(await screen.findByRole('button', { name: 'New service account' }));
    const dialog = await screen.findByRole('dialog', { name: 'New service account' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'ETL runner');
    expect(within(dialog).getByLabelText(/URL name/)).toHaveValue('etl-runner');
    await user.selectOptions(await within(dialog).findByLabelText(/^Team/), 't-data');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await expectSent(capture, 'post', '/service-accounts')).toEqual({
      teamId: 't-data',
      slug: 'etl-runner',
      displayName: 'ETL runner',
      authMethod: 'client_secret_basic',
    });
    const secret = await screen.findByRole('dialog', { name: 'Service account credentials' });
    expect(within(secret).getByText(/Copy the secret now/)).toBeInTheDocument();
    capture.stop();
  });

  it('9.4 a private key service account sends its public keys', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=service');
    await user.click(await screen.findByRole('button', { name: 'New service account' }));
    const dialog = await screen.findByRole('dialog', { name: 'New service account' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Agent');
    await user.selectOptions(await within(dialog).findByLabelText(/^Team/), 't-platform');
    await user.selectOptions(within(dialog).getByLabelText('Sign in with'), 'private_key_jwt');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/Paste the public keys/)).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Public keys/));
    await user.paste('{"keys":[{"kty":"RSA","kid":"k1","n":"abc","e":"AQAB"}]}');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await expectSent(capture, 'post', '/service-accounts')).toEqual({
      teamId: 't-platform',
      slug: 'agent',
      displayName: 'Agent',
      authMethod: 'private_key_jwt',
      jwks: [{ kty: 'RSA', kid: 'k1', n: 'abc', e: 'AQAB' }],
    });
    capture.stop();
  });

  it('9.4 rotating a service account posts to its credentials', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=service');
    await user.click(await screen.findByRole('button', { name: 'Rotate credentials of ci-bot' }));
    await expectSent(capture, 'post', '/service-accounts/sa-1/credentials');
    expect(
      await screen.findByRole('dialog', { name: 'Service account credentials' }),
    ).toBeInTheDocument();
    capture.stop();
  });

  it('9.1 an IdP group mapping to a team sends the group pattern, target and priority', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=mapping');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'New mapping rule' });
    await user.type(within(dialog).getByLabelText(/^IdP group/), 'sec-(.*)');
    await user.selectOptions(within(dialog).getByLabelText('Maps to'), 'team');
    await user.selectOptions(await within(dialog).findByLabelText('Team'), 't-platform');
    await user.selectOptions(within(dialog).getByLabelText('Team role'), 'manager');
    await user.selectOptions(within(dialog).getByLabelText('Identity provider'), 'idp-1');
    const priority = within(dialog).getByLabelText('Priority');
    await user.clear(priority);
    await user.type(priority, '25');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await expectSent(capture, 'post', '/role-mapping-rules')).toEqual({
      idpConnectionId: 'idp-1',
      groupPattern: 'sec-(.*)',
      mapsTo: { teamId: 't-platform', teamRole: 'manager' },
      priority: 25,
    });
    capture.stop();
  });

  it('9.1 an IdP group mapping to a role sends the role', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=mapping');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'New mapping rule' });
    await user.type(within(dialog).getByLabelText(/^IdP group/), 'auditors');
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'auditor');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await expectSent(capture, 'post', '/role-mapping-rules')).toEqual({
      idpConnectionId: null,
      groupPattern: 'auditors',
      mapsTo: { orgRole: 'auditor' },
      priority: 100,
    });
    capture.stop();
  });

  it('9.4 registering an OAuth client sends its id and the decision', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=clients');
    await user.click(await screen.findByRole('button', { name: 'Register client' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register an OAuth client' });
    await user.type(within(dialog).getByLabelText(/Client id/), 'vscode-desktop');
    await user.click(within(dialog).getByRole('button', { name: 'Register' }));
    expect(await expectSent(capture, 'post', '/oauth-clients')).toEqual({
      clientId: 'vscode-desktop',
      preApproved: true,
      blocked: false,
    });
    capture.stop();
  });

  it('9.4 approving and blocking an OAuth client patch its policy flags', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=clients');
    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0] as HTMLElement);
    expect(await expectSent(capture, 'patch', '/oauth-clients/dcr-9f2c11')).toEqual({
      preApproved: true,
      blocked: false,
    });
    await user.click((await screen.findAllByRole('button', { name: 'Block' }))[0] as HTMLElement);
    await waitFor(() =>
      expect(
        capture.calls.filter((c) => c.method === 'patch' && /oauth-clients\//.test(c.path)),
      ).toHaveLength(2),
    );
    await expectSent(capture, 'patch', /oauth-clients\//);
    capture.stop();
  });

  it('10.3 a tool rule sends name, effect, who, what, when, priority and owner', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'New tool rule' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'No Slack for support');
    await user.selectOptions(await within(dialog).findByLabelText('Add a team'), 't-support');
    await user.selectOptions(await within(dialog).findByLabelText('Add a server'), 'i-slack');
    await user.type(within(dialog).getByLabelText('Add a tool pattern'), 'slack_post_*{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Mon' }));
    await user.click(within(dialog).getByRole('button', { name: 'Set hours' }));
    await user.type(within(dialog).getByLabelText('Add an IP range'), '10.0.0.0/8{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await expectSent(capture, 'post', '/policy-rules')).toEqual({
      name: 'No Slack for support',
      ownerTeamId: null,
      effect: 'forbid',
      who: { teams: ['t-support'] },
      what: { installationId: 'i-slack', toolName: 'slack_post_*' },
      when: { weekdays: [1], hours: { from: 8, to: 19 }, ipCidrs: ['10.0.0.0/8'] },
      enabled: true,
      priority: 100,
    });
    capture.stop();
  });

  it('10.3 editing a tool rule patches the whole rule and removing a chip removes the field', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access');
    const rows = await screen.findAllByRole('button', { name: 'Edit' });
    await user.click(rows[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Edit tool rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove delete_*' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    const body = (await expectSent(capture, 'patch', /policy-rules\//)) as {
      what: Record<string, unknown>;
    };
    expect(body.what).toEqual({ installationId: 'i-github' });
    capture.stop();
  });

  it('10.3 a tool rule needs a name', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'New tool rule' });
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await within(dialog).findByText('Name the rule')).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/policy-rules'))).toBe(
      false,
    );
    capture.stop();
  });

  it('10.4 the simulator sends a principal, an action and a tool resource', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: /Simulate/ }));
    expect(await expectSent(capture, 'post', '/policies/simulate')).toEqual({
      principal: {
        kind: 'user',
        id: 'u-ana',
        role: 'member',
        teams: [{ id: 't-support', role: 'manager' }],
      },
      action: 'callTool',
      resource: {
        type: 'Tool',
        installation: { id: expect.any(String), catalogEntryId: expect.any(String) },
        name: 'slack_post_message',
      },
    });
    capture.stop();
  });

  it('10.3 a custom policy is validated with its tests and saved with them', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: /Custom Cedar policies/ }));
    expect(await screen.findByText('The policy is valid.')).toBeInTheDocument();
    const validated = (await expectSent(capture, 'post', '/policies/validate')) as {
      cedar: string;
      tests: unknown[];
    };
    expect(validated.tests).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    const saved = (await expectSent(capture, 'patch', /custom-policies\//)) as Record<
      string,
      unknown
    >;
    expect(saved).toMatchObject({ name: 'Support Slack guard', enabled: true });
    expect(saved.tests).toHaveLength(1);
    capture.stop();
  });

  it('10.3 a new custom policy needs a test before it is valid', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access');
    await user.click(await screen.findByRole('button', { name: /Custom Cedar policies/ }));
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    expect(await screen.findByText(/At least one test case is required/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeDisabled();
    const dialog = screen.getByRole('dialog', { name: 'Custom Cedar policies' });
    await user.type(within(dialog).getByLabelText('Test name'), 'Anyone may call');
    await user.type(within(dialog).getByLabelText('Test tool'), 'search_issues');
    await user.selectOptions(within(dialog).getByLabelText('Expected answer'), 'allow');
    await user.click(within(dialog).getByRole('button', { name: 'Add test' }));
    expect(await within(dialog).findByText('The policy is valid.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Everyone may call');
    await user.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    const saved = (await expectSent(capture, 'post', '/custom-policies')) as Record<
      string,
      unknown
    >;
    expect(saved).toMatchObject({ name: 'Everyone may call', enabled: true });
    capture.stop();
  });

  it('10.1 adding and removing a team member send the membership role', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=teams');
    const select = await screen.findByLabelText('Add a person to Support');
    await user.selectOptions(select, 'u-raj');
    expect(await expectSent(capture, 'put', '/teams/t-support/members/u-raj')).toEqual({
      role: 'member',
    });
    await user.click(await screen.findByRole('button', { name: 'Remove Max Rivera from Support' }));
    await waitFor(() =>
      expect(
        capture.calls.some(
          (c) => c.method === 'delete' && c.path.endsWith('/teams/t-support/members/u-max'),
        ),
      ).toBe(true),
    );
    capture.stop();
  });

  it('10.1 an Admin gives a person a role from the People list, and the request names only the role', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=people');
    const select = await screen.findByLabelText('Role of Raj Mehta');
    await user.selectOptions(select, 'admin');
    expect(await expectSent(capture, 'patch', '/users/u-raj')).toEqual({ orgRole: 'admin' });
    await waitFor(() =>
      expect(getDb().data.access.users.find((u) => u.id === 'u-raj')?.orgRole).toBe('admin'),
    );
    capture.stop();
  });

  it('10.1 the last administrator cannot be demoted: the refusal is shown next to the list', async () => {
    const { user } = await renderRoute('/access?tab=people');
    await user.selectOptions(await screen.findByLabelText('Role of Dana Whitfield'), 'member');
    expect(await screen.findByRole('alert')).toHaveTextContent('last active administrator');
    expect(getDb().data.access.users.find((u) => u.id === 'u-dana')?.orgRole).toBe('admin');
  });

  it('10.1 a team manager makes a member a manager, and back to a member', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/access?tab=teams');
    await user.click(
      await screen.findByRole('button', { name: 'Make Jo Okafor a manager of Data platform' }),
    );
    expect(await expectSent(capture, 'put', '/teams/t-data/members/u-jo')).toEqual({
      role: 'manager',
    });
    await user.click(
      await screen.findByRole('button', { name: 'Make Jo Okafor a member of Data platform' }),
    );
    expect(await expectSent(capture, 'put', '/teams/t-data/members/u-jo')).toEqual({
      role: 'member',
    });
    capture.stop();
  });
});
