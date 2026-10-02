import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/mocks/db';
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
