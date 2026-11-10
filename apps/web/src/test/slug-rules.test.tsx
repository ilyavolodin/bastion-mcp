import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { captureRequests } from './capture';
import { renderRoute } from './utils';

const MESSAGE = 'Use 2 to 40 lowercase letters, digits and dashes';

const CASES: { slug: string; ok: boolean }[] = [
  { slug: 'a', ok: false },
  { slug: 'ab', ok: true },
  { slug: 'A-b', ok: false },
  { slug: 'a'.repeat(40), ok: true },
  { slug: 'a'.repeat(41), ok: false },
  { slug: 'a_b', ok: false },
];

describe('11.4 URL name rule is the same on the install dialog and the endpoint dialog', () => {
  for (const { slug, ok } of CASES) {
    it(`install dialog: "${slug}" is ${ok ? 'accepted' : 'refused'}`, async () => {
      const capture = captureRequests();
      const { user } = await renderRoute('/store?entry=servicedesk');
      await user.click(await screen.findByRole('button', { name: 'Install' }));
      const dialog = await screen.findByRole('dialog', { name: /Install ServiceDesk/ });
      const url = within(dialog).getByLabelText(/URL name/);
      await user.clear(url);
      await user.type(url, slug);
      await user.click(within(dialog).getByRole('button', { name: 'Install' }));
      if (ok) {
        await waitFor(() =>
          expect(
            capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/installations')),
          ).toBe(true),
        );
        expect(within(dialog).queryByText(MESSAGE)).toBeNull();
      } else {
        expect(await within(dialog).findByText(MESSAGE)).toBeInTheDocument();
        expect(
          capture.calls.some((c) => c.method === 'post' && c.path.endsWith('/installations')),
        ).toBe(false);
      }
      capture.stop();
    });

    it(`endpoint dialog: "${slug}" is ${ok ? 'accepted' : 'refused'}`, async () => {
      const { user } = await renderRoute('/servers?tab=endpoints');
      await user.click(await screen.findByRole('button', { name: 'New endpoint' }));
      const dialog = await screen.findByRole('dialog', { name: 'New endpoint' });
      await user.type(within(dialog).getByLabelText(/^Name/), 'Ops');
      const url = within(dialog).getByLabelText(/URL name/);
      await user.clear(url);
      await user.type(url, slug);
      await user.click(within(dialog).getByRole('button', { name: 'Create endpoint' }));
      expect(await within(dialog).findByText('Pick at least one server')).toBeInTheDocument();
      if (ok) expect(within(dialog).queryByText(MESSAGE)).toBeNull();
      else expect(within(dialog).getByText(MESSAGE)).toBeInTheDocument();
    });
  }
});
