import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * Every catalog form is submitted through the real screen; the body that reaches the API is validated against the
 * OpenAPI request schema with ajv (including the serialized `serverSpec`) and checked for the values the user typed
 * (11.1, 11.3, 11.5, 25.2, 17.2).
 */

type Spec = Record<string, unknown>;
type Sent = {
  serverSpec: Spec;
  installForm: { variables: unknown[]; secrets: unknown[] };
} & Record<string, unknown>;

describe('Catalog forms send what the API requires (17.2)', () => {
  it('11.1 a new entry creates the draft entry with slug and kind, then its first version with the spec', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/new');
    await user.type(await screen.findByLabelText(/Display name/), 'Warehouse SQL');
    expect(screen.getByLabelText('URL name')).toHaveValue('warehouse-sql');
    await user.type(screen.getByLabelText('Package'), '@acme/wh-mcp');
    await user.clear(screen.getByLabelText('Version'));
    await user.type(screen.getByLabelText('Version'), '2.0.1');
    expect(screen.getByLabelText('Version label')).toHaveValue('2.0.1');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await expectSent(capture, 'post', '/catalog')).toMatchObject({
      slug: 'warehouse-sql',
      kind: 'mcp_server',
      displayName: 'Warehouse SQL',
      userOverrides: 'cosmetic',
      onDrift: 'hideChanged',
      autoUpgrade: true,
    });
    const version = (await expectSent(capture, 'post', /\/catalog\/[^/]+\/versions$/)) as Sent;
    expect(version).toMatchObject({ label: '2.0.1', changelog: null });
    expect(version.serverSpec).toMatchObject({
      type: 'package',
      runtime: 'npm',
      identifier: '@acme/wh-mcp',
      version: '2.0.1',
      auth: { mode: 'none' },
    });
    await waitFor(() =>
      expect(getDb().data.catalog.entries.some((e) => e.slug === 'warehouse-sql')).toBe(true),
    );
    capture.stop();
  });

  it('11.4 variables, a personal API key and the egress allowlist become a real ServerSpec and install form', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/new');
    await user.type(await screen.findByLabelText(/Display name/), 'Billing');
    await user.type(screen.getByLabelText('Package'), 'billing-mcp');

    await user.click(screen.getByRole('button', { name: /Configuration/ }));
    await user.click(await screen.findByRole('button', { name: 'Add variable' }));
    await user.type(screen.getByLabelText('Name'), 'REGION');
    await user.type(screen.getByLabelText('Label'), 'Region');
    await user.click(screen.getByRole('button', { name: 'Add variable' }));
    const names = screen.getAllByLabelText('Name');
    await user.type(names[1] as HTMLElement, 'API_TOKEN');
    await user.type(screen.getAllByLabelText('Label')[1] as HTMLElement, 'API token');
    await user.click(screen.getAllByLabelText('Secret')[1] as HTMLElement);

    await user.click(screen.getByRole('button', { name: /Authentication/ }));
    await user.click(await screen.findByLabelText(/Personal API key/));

    await user.click(screen.getByRole('button', { name: /Network/ }));
    await user.type(await screen.findByLabelText('Add a host'), '*.billing.example.com:443');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await expectSent(capture, 'post', '/catalog');
    const version = (await expectSent(capture, 'post', /\/catalog\/[^/]+\/versions$/)) as Sent;
    expect(version.serverSpec).toMatchObject({
      type: 'package',
      egress: { allow: ['*.billing.example.com:443'] },
      environmentVariables: [{ name: 'REGION', value: '{{var.REGION}}', isRequired: true }],
      auth: {
        mode: 'userSecret',
        fields: [{ name: 'API_TOKEN', label: 'API token' }],
        inject: [{ to: 'env', name: 'API_TOKEN', value: '{{secret.API_TOKEN}}' }],
      },
    });
    expect(version.installForm).toEqual({
      variables: [{ name: 'REGION', label: 'Region', required: true }],
      secrets: [{ name: 'API_TOKEN', label: 'API token' }],
    });
    capture.stop();
  });

  it('11.1 a remote server with OAuth sends transport, url and an oauth auth block', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/new');
    await user.type(await screen.findByLabelText(/Display name/), 'Acme CRM');
    await user.selectOptions(screen.getByLabelText('Runtime'), 'remote');
    await user.type(screen.getByLabelText('Server URL'), 'https://mcp.acme.dev/mcp');
    await user.click(screen.getByRole('button', { name: /Authentication/ }));
    await user.click(await screen.findByLabelText(/^OAuth/));
    await user.type(screen.getByLabelText('OAuth scopes'), 'read write');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await expectSent(capture, 'post', '/catalog');
    const version = (await expectSent(capture, 'post', /\/catalog\/[^/]+\/versions$/)) as Sent;
    expect(version.serverSpec).toMatchObject({
      type: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.acme.dev/mcp',
      auth: { mode: 'oauth', client: { registration: 'auto' }, scopes: ['read', 'write'] },
    });
    capture.stop();
  });

  it('11.1 a draft the API would refuse is not sent: a range instead of an exact version', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/new');
    await user.type(await screen.findByLabelText(/Display name/), 'Ranged');
    await user.type(screen.getByLabelText('Package'), 'ranged-mcp');
    await user.clear(screen.getByLabelText('Version'));
    await user.type(screen.getByLabelText('Version'), '^1.2.0');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByLabelText(/Display name/);
    expect(capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/catalog'))).toBe(
      false,
    );
    capture.stop();
  });

  it('11.3 saving an existing draft patches the entry, and the version only when its spec changed', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres');
    const name = await screen.findByLabelText(/Display name/);
    await user.clear(name);
    await user.type(name, 'Postgres warehouse');
    // The URL name of an existing entry stays fixed.
    expect(screen.getByLabelText('URL name')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await expectSent(capture, 'patch', '/catalog/c-postgres')).toMatchObject({
      displayName: 'Postgres warehouse',
      onDrift: 'hideChanged',
      userOverrides: 'cosmetic',
    });
    expect(capture.calls.some((c) => c.method === 'patch' && c.path.includes('/versions/'))).toBe(
      false,
    );

    await user.click(screen.getByRole('button', { name: /Source/ }));
    const pkg = await screen.findByLabelText('Package');
    await user.clear(pkg);
    await user.type(pkg, '@acme/pg-mcp-next');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const sent = (await expectSent(
      capture,
      'patch',
      /\/catalog\/c-postgres\/versions\/[^/]+$/,
    )) as Sent;
    // The org secret and the egress allowlist that the editor does not change are kept.
    expect(sent.serverSpec).toMatchObject({
      identifier: '@acme/pg-mcp-next',
      egress: { allow: ['warehouse.acme.internal'] },
      auth: { mode: 'orgSecret', inject: [{ to: 'env', name: 'DATABASE_URL' }] },
    });
    capture.stop();
  });

  it('11.3 publishing sends the visibility the publisher chose', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog/c-postgres?step=publish');
    await user.click(await screen.findByRole('button', { name: 'Publish v3.2.0' }));
    const body = (await expectSent(capture, 'post', /\/versions\/[^/]+\/publish$/)) as {
      visibility: { org: boolean; teamIds: string[] };
    };
    expect(body.visibility.org).toBe(false);
    expect(body.visibility.teamIds).toEqual(['t-data', 't-analytics']);
    capture.stop();
  });

  it('11.5 a new auto-install policy sends the target, mode, scope and flags the API requires', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog?tab=policies');
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const dialog = await screen.findByRole('dialog', { name: /New auto-install policy/ });
    await user.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    expect(await within(dialog).findByText('Pick the entry to install')).toBeInTheDocument();

    await user.selectOptions(await within(dialog).findByLabelText(/Entry/), 'c-slack');
    await user.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    expect(await within(dialog).findByText('Pick at least one target')).toBeInTheDocument();
    expect(
      capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/auto-install-policies')),
    ).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Everyone' }));
    await user.selectOptions(within(dialog).getByLabelText('Add a role'), 'manager');
    await user.type(within(dialog).getByLabelText('Add an IdP group'), 'eng-platform{Enter}');
    await user.selectOptions(within(dialog).getByLabelText('Mode'), 'required');
    await user.selectOptions(within(dialog).getByLabelText('Scope'), 'team');
    await user.selectOptions(within(dialog).getByLabelText('Existing users'), 'newOnly');
    await user.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    expect(await expectSent(capture, 'post', '/auto-install-policies')).toEqual({
      catalogEntryId: 'c-slack',
      target: { all: true, roles: ['manager'], idpGroups: ['eng-platform'] },
      mode: 'required',
      scope: 'team',
      applyToExisting: false,
      enabled: true,
    });
    await waitFor(() =>
      expect(getDb().data.catalog.autoInstall.some((p) => p.catalogEntryId === 'c-slack')).toBe(
        true,
      ),
    );
    capture.stop();
  });

  it('11.5 editing a policy patches it and previews the unsaved audience', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/catalog?tab=policies');
    const card = await screen.findByRole('region', { name: 'Postgres analytics' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit auto-install policy/ });
    await user.click(within(dialog).getByRole('button', { name: 'Everyone' }));
    const preview = (await expectSent(
      capture,
      'post',
      /\/auto-install-policies\/ap-2\/preview$/,
    )) as {
      target: { all: boolean };
    };
    expect(preview.target.all).toBe(true);
    await user.selectOptions(within(dialog).getByLabelText('Mode'), 'default');
    await user.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    expect(await expectSent(capture, 'patch', '/auto-install-policies/ap-2')).toMatchObject({
      target: { all: true },
      mode: 'default',
      scope: 'team',
      enabled: true,
    });
    capture.stop();
  });

  it('25.2 saving SKILL.md sends the file as UTF-8 base64 with its mode', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/plugins/edit/c-incident-kit');
    const description = await screen.findByLabelText(/^Description\s\*/);
    await user.clear(description);
    await user.type(description, 'Triage the incident, then décrire la chronologie');
    await user.click(screen.getByRole('button', { name: 'Save SKILL.md' }));
    const body = (await expectSent(capture, 'put', /\/files\/SKILL\.md$/)) as {
      contentBase64: string;
      mode: string;
    };
    expect(body.mode).toBe('file');
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(body.contentBase64), (c) => c.charCodeAt(0)),
    );
    expect(text).toContain('description: Triage the incident, then décrire la chronologie');
    capture.stop();
  });

  it('25.2 an executable file keeps its executable mode when it is saved', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/plugins/edit/c-incident-kit');
    await user.click(await screen.findByRole('button', { name: /hooks\/post-tool\.sh/ }));
    await screen.findByLabelText('Contents of hooks/post-tool.sh');
    await user.click(screen.getByRole('button', { name: 'Save file' }));
    const body = (await expectSent(capture, 'put', /\/files\/hooks\/post-tool\.sh$/)) as {
      mode: string;
    };
    expect(body.mode).toBe('executable');
    capture.stop();
  });
});
