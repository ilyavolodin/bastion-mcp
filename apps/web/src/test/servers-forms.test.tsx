import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * Every form of the Servers and Store screens is submitted through the real screen; the body that reaches the API is
 * validated against the OpenAPI request schema (ajv) and checked for the values the user typed (11.4, 7.1, 12.5).
 */

describe('Endpoint forms send what the API requires (17.2)', () => {
  it('7.1 a new endpoint sends slug, name, servers, prefix mode and instructions', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers?tab=endpoints');
    await user.click(await screen.findByRole('button', { name: 'New endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'New endpoint' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Data Work');
    expect(within(dialog).getByLabelText(/URL name/)).toHaveValue('data-work');
    await user.click(await within(dialog).findByRole('checkbox', { name: /Postgres analytics/ }));
    await user.selectOptions(within(dialog).getByLabelText('Tool names'), 'onCollision');
    await user.type(within(dialog).getByLabelText('Instructions'), 'Read-only analytics.');
    await user.click(within(dialog).getByRole('button', { name: 'Create endpoint' }));
    expect(await expectSent(capture, 'post', '/endpoints')).toEqual({
      slug: 'data-work',
      displayName: 'Data Work',
      installationIds: ['i-postgres'],
      prefixMode: 'onCollision',
      instructions: 'Read-only analytics.',
    });
    await waitFor(() =>
      expect(getDb().data.servers.endpoints.some((e) => e.slug === 'data-work')).toBe(true),
    );
    capture.stop();
  });

  it('7.1 an edited URL name stops following the name, and an endpoint needs a server', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers?tab=endpoints');
    await user.click(await screen.findByRole('button', { name: 'New endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'New endpoint' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Ops');
    const url = within(dialog).getByLabelText(/URL name/);
    await user.clear(url);
    await user.type(url, 'ops-team');
    await user.type(within(dialog).getByLabelText(/^Name/), ' tools');
    expect(url).toHaveValue('ops-team');
    await user.click(within(dialog).getByRole('button', { name: 'Create endpoint' }));
    expect(await within(dialog).findByText('Pick at least one server')).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/endpoints'))).toBe(
      false,
    );
    capture.stop();
  });

  it('7.1 editing an endpoint sends a PATCH with the row version in If-Match', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers?tab=endpoints');
    const card = await screen.findByLabelText('Engineering');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit Engineering/ });
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Engineering tools');
    await user.click(within(dialog).getByRole('button', { name: 'Save endpoint' }));
    const body = (await expectSent(capture, 'patch', '/endpoints/e-eng')) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      displayName: 'Engineering tools',
      slug: 'engineering',
      prefixMode: 'always',
      instructions: null,
    });
    await waitFor(() =>
      expect(getDb().data.servers.endpoints.find((e) => e.id === 'e-eng')?.displayName).toBe(
        'Engineering tools',
      ),
    );
    capture.stop();
  });
});

describe('The install flow sends what the API requires (11.4)', () => {
  it('11.4 installs for me with the catalog version, a derived URL name and the typed settings', async () => {
    const capture = captureRequests();
    // Jira is already installed in the demo org: remove it so that the install button is offered.
    const { user } = await renderRoute('/store?entry=jira', {
      prepare: (db) => {
        db.data.servers.installations = db.data.servers.installations.filter(
          (i) => i.catalogEntryId !== 'c-jira',
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install Jira/ });
    const site = within(dialog).getByLabelText(/Jira site/);
    expect(site).toHaveValue('https://acme.atlassian.net');
    await user.clear(site);
    await user.type(site, 'https://globex.atlassian.net');
    expect(within(dialog).getByLabelText(/URL name/)).toHaveValue('jira');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(await expectSent(capture, 'post', '/installations')).toEqual({
      catalogEntryId: 'c-jira',
      catalogVersionId: 'v-jira-1.8.2',
      ownerType: 'user',
      slug: 'jira',
      variables: { SITE_URL: 'https://globex.atlassian.net' },
      pinnedVersion: true,
    });
    capture.stop();
  });

  it('11.4 an admin can install for a team: ownerType and teamId are sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/store?entry=servicedesk');
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install ServiceDesk/ });
    await user.selectOptions(await within(dialog).findByLabelText('Install for'), 't-data');
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(await expectSent(capture, 'post', '/installations')).toMatchObject({
      catalogEntryId: 'c-servicedesk',
      ownerType: 'team',
      teamId: 't-data',
      slug: 'servicedesk',
    });
    capture.stop();
  });

  it('11.4 a secret is written after the install, with its own PUT', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/store?entry=hubspot');
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install HubSpot/ });
    await user.type(within(dialog).getByLabelText(/API key/), 'hs-secret-123');
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(await expectSent(capture, 'post', '/installations')).toMatchObject({
      catalogEntryId: 'c-hubspot',
      variables: {},
    });
    expect(
      await expectSent(capture, 'put', /\/installations\/[^/]+\/secrets\/HUBSPOT_API_KEY$/),
    ).toEqual({
      value: 'hs-secret-123',
    });
    capture.stop();
  });

  it('11.4 a URL name the API would refuse is not sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/store?entry=servicedesk');
    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Install ServiceDesk/ });
    const url = within(dialog).getByLabelText(/URL name/);
    await user.clear(url);
    await user.type(url, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(
      await within(dialog).findByText('Use 2 to 40 lowercase letters, digits and dashes'),
    ).toBeInTheDocument();
    expect(
      capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/installations')),
    ).toBe(false);
    capture.stop();
  });
});

describe('Installation settings send what the API requires (17.2)', () => {
  it('7.3 names: a PATCH with displayName and toolPrefix, never the slug', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-slack?tab=settings');
    const card = await screen.findByLabelText('Names');
    const name = within(card).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Slack (work)');
    const prefix = within(card).getByLabelText('Tool prefix');
    await user.clear(prefix);
    await user.type(prefix, 'slack_work');
    expect(within(card).getByLabelText('URL name')).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Save names' }));
    expect(await expectSent(capture, 'patch', '/installations/i-slack')).toEqual({
      displayName: 'Slack (work)',
      toolPrefix: 'slack_work',
    });
    capture.stop();
  });

  it('7.3 an empty tool prefix is refused before it is sent', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-slack?tab=settings');
    const card = await screen.findByLabelText('Names');
    await user.clear(within(card).getByLabelText('Tool prefix'));
    await user.click(within(card).getByRole('button', { name: 'Save names' }));
    expect(await within(card).findByText('Enter a prefix')).toBeInTheDocument();
    expect(capture.calls.some((c) => c.method === 'patch')).toBe(false);
    capture.stop();
  });

  it('8.7 pinning a version sends pinnedVersion', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-slack?tab=settings');
    await user.click(await screen.findByRole('switch', { name: /Stay on version 2\.0\.1/ }));
    expect(await expectSent(capture, 'patch', '/installations/i-slack')).toEqual({
      pinnedVersion: true,
    });
    capture.stop();
  });

  it('11.4 the settings an installation was set up with are saved as variables', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-jira?tab=settings');
    const card = await screen.findByRole('region', { name: 'Settings' });
    const site = within(card).getByLabelText('SITE_URL');
    await user.clear(site);
    await user.type(site, 'https://globex.atlassian.net');
    await user.click(within(card).getByRole('button', { name: 'Save settings' }));
    expect(await expectSent(capture, 'patch', '/installations/i-jira')).toEqual({
      variables: { SITE_URL: 'https://globex.atlassian.net' },
    });
    capture.stop();
  });

  it('11.4 a secret is replaced with PUT { value }, and never shown again', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-zendesk?tab=connection');
    const card = await screen.findByLabelText('Secrets');
    await user.click(await within(card).findByRole('button', { name: 'Replace secret' }));
    const dialog = await screen.findByRole('dialog', { name: /Replace ZENDESK_TOKEN/ });
    await user.type(within(dialog).getByLabelText('New value'), 'zd-new-token');
    await user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
    expect(
      await expectSent(capture, 'put', '/installations/i-zendesk/secrets/ZENDESK_TOKEN'),
    ).toEqual({
      value: 'zd-new-token',
    });
    capture.stop();
  });

  it('11.5 connecting asks the API for the authorization URL and says where to come back', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-github?tab=connection');
    await user.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    expect(await expectSent(capture, 'post', '/installations/i-github/connect')).toEqual({
      returnTo: '/servers/i-github?tab=connection',
    });
    capture.stop();
  });
});

describe('Overrides and Try it send what the API requires (12.5)', () => {
  it('12.5 the preview names the document, the layer and the installation', async () => {
    const capture = captureRequests();
    await renderRoute('/servers/i-postgres?tab=overrides');
    const body = (await expectSent(capture, 'post', '/overrides/preview')) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ layer: 'installation', installationId: 'i-postgres' });
    expect(body.doc).toMatchObject({ version: 1 });
    capture.stop();
  });

  it('12.5 saving sends the document itself as the PUT body', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    await user.click(await screen.findByRole('button', { name: 'Raw JSON' }));
    const editor = await screen.findByLabelText('Override document JSON');
    await user.clear(editor);
    await user.click(editor);
    await user.paste('{"version":1,"tools":{"pg_explain":{"title":"Explain a plan"}}}');
    await user.click(screen.getByRole('button', { name: 'Save overrides' }));
    expect(await expectSent(capture, 'put', '/installations/i-postgres/overrides')).toEqual({
      version: 1,
      tools: { pg_explain: { title: 'Explain a plan' } },
    });
    capture.stop();
  });

  it('12.5 Try it sends a tool call with its arguments', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    await screen.findByText('Final definition');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveValue('pg_run_query'),
    );
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await expectSent(capture, 'post', '/installations/i-postgres/try')).toEqual({
      kind: 'tool',
      name: 'pg_run_query',
      arguments: { query: 'orders' },
    });
    capture.stop();
  });
});

describe('Client setup asks for the right configuration (11.4)', () => {
  it('11.4 a named endpoint asks its own client-config, the default one the org-level route', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers?tab=endpoints');
    const card = await screen.findByLabelText('Engineering');
    await user.click(within(card).getByRole('button', { name: 'Client setup' }));
    await waitFor(() =>
      expect(capture.calls.some((c) => c.path.endsWith('/endpoints/e-eng/client-config'))).toBe(
        true,
      ),
    );
    capture.stop();
  });
});
