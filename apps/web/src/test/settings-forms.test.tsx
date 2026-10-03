import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/** Each form submits through the real screen; the body that reaches the API is validated against its schema (17.2). */

const clear = async (user: Awaited<ReturnType<typeof renderRoute>>['user'], el: HTMLElement) => {
  await user.clear(el);
};

describe('Settings forms send what the API accepts (19.2)', () => {
  it('19.2 organization: PATCH /settings carries the whole org object', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings');
    const name = await screen.findByLabelText(/Display name/);
    await clear(user, name);
    await user.type(name, 'Acme Inc');
    await user.click(screen.getByRole('button', { name: 'Save organization' }));
    const body = await expectSent(capture, 'patch', '/settings');
    expect(body).toEqual({ org: { displayName: 'Acme Inc', timeZone: 'America/New_York' } });
    capture.stop();
  });

  it('19.2 installs: personalInstalls and the tool warning threshold go in one PATCH', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings');
    await user.selectOptions(await screen.findByLabelText('Personal installs'), 'all');
    const threshold = screen.getByLabelText('Warn above this many tools per endpoint');
    await clear(user, threshold);
    await user.type(threshold, '55');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await expectSent(capture, 'patch', '/settings')).toEqual({
      personalInstalls: 'all',
      endpoints: { toolWarnThreshold: 55 },
    });
    capture.stop();
  });

  it('19.2 sandboxes: the whole sandbox object is sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=sandboxes');
    await user.selectOptions(await screen.findByLabelText('Default size'), 'medium');
    await user.click(screen.getByRole('button', { name: 'Save sandboxes' }));
    const body = (await expectSent(capture, 'patch', '/settings')) as {
      sandbox: { defaultSize: string; warmPool: object; idleTimeoutMinutes: number };
    };
    expect(body.sandbox.defaultSize).toBe('medium');
    expect(body.sandbox.warmPool).toEqual({ small: 5, medium: 2, large: 0 });
    capture.stop();
  });

  it('19.2 retention: logs and audit objects, an empty webhook is null', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=retention');
    const days = await screen.findByLabelText('Audit log (days)');
    await clear(user, days);
    await user.type(days, '400');
    await user.click(screen.getByRole('button', { name: 'Save retention' }));
    const body = await expectSent(capture, 'patch', '/settings');
    expect(body).toMatchObject({ audit: { retentionDays: 400, webhookUrl: null } });
    capture.stop();
  });

  it('9.4 a new IdP connection collects every required field and derives the discovery URL', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=idp');
    await user.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name( \*)?$/), 'Entra');
    await user.type(within(dialog).getByLabelText(/^Issuer/), 'https://login.acme.com/');
    expect(within(dialog).getByLabelText(/^Discovery URL/)).toHaveValue(
      'https://login.acme.com/.well-known/openid-configuration',
    );
    await user.type(within(dialog).getByLabelText(/^Client ID/), 'bastion');
    await user.type(within(dialog).getByLabelText(/^Client secret/), 's3cret');
    await user.type(within(dialog).getByLabelText('Groups claim'), 'groups');
    await user.type(within(dialog).getByLabelText('Allowed email domains'), 'acme.dev, acme.io');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    const body = await expectSent(capture, 'post', '/idp-connections');
    expect(body).toEqual({
      name: 'Entra',
      issuer: 'https://login.acme.com/',
      discoveryUrl: 'https://login.acme.com/.well-known/openid-configuration',
      clientId: 'bastion',
      clientSecret: 's3cret',
      scopes: ['openid', 'email', 'profile'],
      claimMap: { groups: 'groups' },
      emailDomains: ['acme.dev', 'acme.io'],
      storeRefreshToken: false,
      apiScope: null,
      enterpriseManagedAuth: false,
      redirectToRoot: false,
      enabled: true,
    });
    await waitFor(() => expect(getDb().data.settings.idpConnections).toHaveLength(2));
    capture.stop();
  });

  it('9.4 the IdP form validates URLs and the secret before it sends anything', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=idp');
    await user.click(await screen.findByRole('button', { name: 'Add connection' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name( \*)?$/), 'Bad');
    await user.type(within(dialog).getByLabelText(/^Issuer/), 'not a url');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    expect((await within(dialog).findAllByText('Enter a full URL')).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('Required').length).toBeGreaterThan(0);
    expect(capture.calls.some((c) => c.method === 'post')).toBe(false);
    capture.stop();
  });

  it('9.1 each connection shows the redirect URI to register in the identity provider', async () => {
    await renderRoute('/settings?section=idp');
    const field = await screen.findByText('Redirect URI of Okta', { exact: false });
    // The address the IdP must list: this Bastion's public address plus the connection's callback path.
    const base = getDb().me.org.baseUrl.replace(/\/$/, '');
    expect(field.closest('div')).toHaveTextContent(`${base}/auth/callback/idp-1`);
    expect(screen.getByRole('button', { name: /Copy Redirect URI of Okta/ })).toBeVisible();
  });

  it('9.1 a connection for an IdP that accepts only the site address shows that address as its redirect URI', async () => {
    await renderRoute('/settings?section=idp', {
      prepare: (db) => {
        const row = db.data.settings.idpConnections[0];
        if (!row) throw new Error('fixture missing');
        row.redirectToRoot = true;
      },
    });
    const field = await screen.findByText('Redirect URI of Okta', { exact: false });
    const base = getDb().me.org.baseUrl.replace(/\/$/, '');
    const text = field.closest('div')?.textContent ?? '';
    expect(text).toContain(base);
    expect(text).not.toContain('/auth/callback');
  });

  it('9.1 the redirect-to-site-address switch is sent with the connection', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=idp');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('switch', { name: 'Redirect to the site address only' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    const body = (await expectSent(capture, 'patch', '/idp-connections/idp-1')) as Record<
      string,
      unknown
    >;
    expect(body.redirectToRoot).toBe(true);
    await waitFor(() => expect(getDb().data.settings.idpConnections[0]?.redirectToRoot).toBe(true));
    capture.stop();
  });

  it('9.4 editing a connection leaves the client secret out unless a new one is typed', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=idp');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/^Name( \*)?$/);
    await clear(user, name);
    await user.type(name, 'Okta (prod)');
    await user.click(within(dialog).getByRole('button', { name: 'Save connection' }));
    const body = (await expectSent(capture, 'patch', '/idp-connections/idp-1')) as Record<
      string,
      unknown
    >;
    expect(body.name).toBe('Okta (prod)');
    expect('clientSecret' in body).toBe(false);
    capture.stop();
  });

  it('13.5 model guards: an enabled guard is its config, a disabled one is null, secrets are references', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=guards');
    await user.click(await screen.findByRole('switch', { name: 'Enable JEV guard' }));
    await user.click(screen.getByRole('switch', { name: 'Enable LLM judge' }));
    await user.click(screen.getByRole('button', { name: 'Save model guards' }));
    const body = await expectSent(capture, 'put', '/settings/model-guards');
    expect(body).toEqual({
      jev: {
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        model: 'jev-1.13.0',
        apiKeySecret: 'secret:TYPESAFE_API_KEY',
        thresholds: { block: 0.85, quarantine: 0.6, warn: 0.4 },
        timeoutMs: 1500,
      },
      llmJudge: null,
      classifier: null,
    });
    capture.stop();
  });

  it('13.5 model guards: an unpinned JEV model is refused on the page', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=guards');
    await user.click(await screen.findByRole('switch', { name: 'Enable JEV guard' }));
    const model = screen.getAllByLabelText('Model')[0] as HTMLElement;
    await clear(user, model);
    await user.type(model, 'jev-latest');
    await user.click(screen.getByRole('button', { name: 'Save model guards' }));
    expect(await screen.findByText(/Pin an exact model version/)).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'put')).toBe(false);
    capture.stop();
  });

  it('14.1 a rate limit sends kind-specific params, scope and subject', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=limits');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name( \*)?$/), 'GitHub writes');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'rate');
    const points = within(dialog).getByLabelText('Calls allowed');
    await clear(user, points);
    await user.type(points, '30');
    await user.type(within(dialog).getByLabelText('Tool'), 'github__*');
    await user.selectOptions(within(dialog).getByLabelText('When exceeded'), 'warn');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    const body = await expectSent(capture, 'post', '/limit-rules');
    expect(body).toEqual({
      name: 'GitHub writes',
      kind: 'rate',
      subject: 'user',
      subjectMatch: 'each',
      scope: { tool: 'github__*' },
      metric: 'calls',
      action: 'warn',
      enabled: true,
      params: { points: 30, perSeconds: 60, burst: 0 },
    });
    expect(await screen.findByText('GitHub writes')).toBeInTheDocument();
    capture.stop();
  });

  it('14.1 a quota and a concurrency rule use their own parameters; the kind is fixed when editing', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=limits');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name( \*)?$/), 'Slots');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'concurrency');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await expectSent(capture, 'post', '/limit-rules')).toMatchObject({
      kind: 'concurrency',
      params: { max: 8, leaseSeconds: 900 },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = (await screen.findByText('Tool calls per user')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Kind')).toBeDisabled();
    const allowance = within(dialog).getByLabelText('Allowance');
    await clear(user, allowance);
    await user.type(allowance, '7000');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    const body = (await expectSent(capture, 'patch', '/limit-rules/lr-1')) as Record<
      string,
      unknown
    >;
    expect(body.params).toEqual({ points: 7000, period: 'day' });
    expect('kind' in body).toBe(false);
    capture.stop();
  });

  it('14.1 an invalid limit is refused before it is sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=limits');
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name( \*)?$/), 'Zero');
    const points = within(dialog).getByLabelText('Allowance');
    await clear(user, points);
    await user.type(points, '0');
    await user.click(within(dialog).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog).findByText('Must be above zero')).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'post')).toBe(false);
    capture.stop();
  });

  it('14.1 deleting a limit calls DELETE /limit-rules/{id}', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=limits');
    await user.click(await screen.findByRole('button', { name: 'Delete Burst rate' }));
    await capture.next('delete', '/limit-rules/lr-2');
    await waitFor(() =>
      expect(getDb().data.settings.limitRules.some((r) => r.id === 'lr-2')).toBe(false),
    );
    capture.stop();
  });

  it('22.3 rotating the keys posts to /system/kms/rotate and reports the re-wrapped keys', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=kms');
    await user.click(await screen.findByRole('button', { name: 'Rotate keys' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rotate' }),
    );
    await capture.next('post', '/system/kms/rotate');
    expect(await screen.findByText(/128 data keys re-wrapped/)).toBeInTheDocument();
    capture.stop();
  });
});
