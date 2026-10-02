import { screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
import { server } from '@/mocks/server';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * The Registry forms are submitted through the real screen; the body that reaches the API is validated against the
 * OpenAPI request schema (ajv) and checked for the values the user typed (11.7, 17.2).
 */

const card = async (name: RegExp) =>
  within((await screen.findByRole('heading', { name })).closest('article') as HTMLElement);

describe('Registry forms send what the API requires (17.2)', () => {
  it('11.7 installing sends the source, name and version of the listed server', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/registry');
    await user.click((await card(/com\.figma/)).getByRole('button', { name: 'Install' }));
    expect(await expectSent(capture, 'post', '/registry/install')).toEqual({
      sourceId: 'rs-official',
      name: 'com.figma/mcp',
      version: '0.9.2',
    });
    capture.stop();
  });

  it('11.7 a policy that asks for approval opens the request form with the justification the API requires', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/registry');
    await user.click((await card(/stripe/)).getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Request io\.github\.stripe\/mcp/ });
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText('Say what you need it for')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/What do you need it for/), '  Payments  ');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await expectSent(capture, 'post', '/install-requests')).toEqual({
      sourceId: 'rs-official',
      name: 'io.github.stripe/mcp',
      version: '1.5.0',
      justification: 'Payments',
    });
    await waitFor(() =>
      expect(getDb().data.registry.requests.some((r) => r.justification === 'Payments')).toBe(true),
    );
    capture.stop();
  });

  it('11.7 a request asks for a justification of at most 2000 characters', async () => {
    const { user } = await renderRoute('/registry');
    await user.click((await card(/hr-lookup/)).getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /Request dev\.acme\/hr-lookup/ });
    expect(within(dialog).getByLabelText(/What do you need it for/)).toHaveAttribute(
      'maxlength',
      '2000',
    );
  });

  it('10.1 rejecting a request sends the reason the API requires', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/registry');
    await user.click((await screen.findAllByRole('button', { name: 'Reject' }))[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: /Reject/ });
    await user.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect(await within(dialog).findByText('Give a reason')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Use Linear instead');
    await user.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect(await expectSent(capture, 'post', /\/install-requests\/[^/]+\/reject$/)).toEqual({
      reason: 'Use Linear instead',
    });
    capture.stop();
  });

  it('10.1 approving sends no body', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/registry');
    await user.click((await screen.findAllByRole('button', { name: 'Approve' }))[0] as HTMLElement);
    const sent = await capture.next('post', /\/install-requests\/[^/]+\/approve$/);
    expect(sent.body).toBeUndefined();
    capture.stop();
  });
});

const listCalls = (capture: ReturnType<typeof captureRequests>) =>
  capture.calls
    .filter((c) => c.path === '/api/v1/registry/servers')
    .map((c) => new URLSearchParams(c.search));

const disabledConflict = () =>
  http.post('*/api/v1/registry/install', () =>
    HttpResponse.json(
      {
        type: 'x',
        title: 'Conflict',
        status: 409,
        code: 'source_disabled',
        detail: 'this registry source is disabled',
      },
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    ),
  );

describe('Registry browsing is paged and filtered on the server (11.6)', () => {
  const many = (db: ReturnType<typeof getDb>) => {
    const base = db.data.registry.servers[0] as (typeof db.data.registry.servers)[number];
    db.data.registry.servers = Array.from({ length: 520 }, (_, i) => ({
      ...base,
      summary: {
        ...base.summary,
        name: `io.bulk/server-${String(i).padStart(3, '0')}`,
        description: `bulk entry ${i}`,
        sourceId: 'rs-official',
      },
    }));
  };

  it('11.6 loads one page of 24 and fetches the next only on Load more', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/registry', { prepare: many });
    expect(await screen.findByText('io.bulk/server-000')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(24);
    expect(listCalls(capture)).toHaveLength(1);
    expect(listCalls(capture)[0]?.get('limit')).toBe('24');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(48));
    expect(listCalls(capture)).toHaveLength(2);
    expect(listCalls(capture)[1]?.get('cursor')).toBeTruthy();
    capture.stop();
  });

  it('11.6 a new search starts again at the first page', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/registry', { prepare: many });
    await screen.findByText('io.bulk/server-000');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(48));
    await user.type(screen.getByRole('searchbox', { name: 'Search registries' }), 'entry 51');
    await waitFor(() => {
      const last = listCalls(capture).at(-1);
      expect(last?.get('q')).toBe('entry 51');
      expect(last?.get('cursor')).toBeNull();
    });
    await waitFor(() => expect(screen.getAllByRole('article').length).toBeLessThanOrEqual(24));
    capture.stop();
  });

  it('11.6 shows where the servers come from: source name, trust level and last sync', async () => {
    await renderRoute('/registry');
    const strip = await screen.findByRole('region', { name: 'Active registries' });
    expect(within(strip).getByText('Official MCP Registry')).toBeInTheDocument();
    expect((await card(/com\.figma/)).getByText('Official')).toBeInTheDocument();
  });

  it('11.6 a disabled source is explained, not shown as a raw conflict', async () => {
    const { user } = await renderRoute('/registry');
    const figma = await card(/com\.figma/);
    server.use(disabledConflict());
    await user.click(figma.getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /registry source is disabled/i });
    expect(within(dialog).getByText(/Enable it in Settings -> Registry/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('link', { name: 'Open Registry settings' }),
    ).toBeInTheDocument();
  });

  it('11.6 non-admins are told to ask their admin', async () => {
    const { user } = await renderRoute('/registry', { role: 'member' });
    const figma = await card(/com\.figma/);
    server.use(disabledConflict());
    await user.click(figma.getByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog', { name: /registry source is disabled/i });
    expect(within(dialog).getByText('Ask your admin to enable this registry.')).toBeInTheDocument();
  });
});

describe('Settings -> Registry (11.6, 11.7)', () => {
  it('11.6 toggles a source and saves the install policy', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/settings?section=registry');
    const row = await screen.findByRole('listitem', { name: 'Official MCP Registry' });
    await user.click(within(row).getByRole('switch', { name: 'Enable Official MCP Registry' }));
    const patch = await capture.next('patch', /\/registry-sources\/rs-official$/);
    expect(patch.body).toEqual({ enabled: false });
    await user.click(within(row).getByRole('button', { name: 'Install policy' }));
    const dialog = await screen.findByRole('dialog', { name: /Install policy/ });
    await user.click(await within(dialog).findByRole('button', { name: 'Save policy' }));
    const put = await capture.next('put', /\/registry-sources\/rs-official\/policy$/);
    expect(put.body).toMatchObject({ mode: 'request', allowedRuntimes: ['remote'] });
    capture.stop();
  });

  it('11.6 adding a source shows the SSRF refusal of the server', async () => {
    const { user } = await renderRoute('/settings?section=registry');
    server.use(
      http.post('*/api/v1/registry-sources', () =>
        HttpResponse.json(
          {
            type: 'x',
            title: 'Bad Request',
            status: 400,
            code: 'registry_url_denied',
            detail: 'registry host resolves to a denied address (169.254.169.254)',
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );
    await user.click(await screen.findByRole('button', { name: 'Add source' }));
    const dialog = await screen.findByRole('dialog', { name: /Add a registry source/ });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Meta');
    await user.type(within(dialog).getByLabelText(/^Base URL/), 'https://169.254.169.254');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    expect(await within(dialog).findByText(/denied address/)).toBeInTheDocument();
  });
});
