import { screen, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { renderRoute } from './utils';

/** How the tool rule dialog shows what the form and the server refuse (10.3). */
const problem = (status: number, body: Record<string, unknown>) =>
  http.post('*/api/v1/policy-rules', () =>
    HttpResponse.json(
      { type: 'x', title: 'Refused', status, ...body },
      { status, headers: { 'content-type': 'application/problem+json' } },
    ),
  );

const openDialog = async () => {
  const { user } = await renderRoute('/access');
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  const dialog = await screen.findByRole('dialog', { name: 'New tool rule' });
  await user.type(within(dialog).getByLabelText(/^Name/), 'Rule one');
  return { user, dialog };
};

describe('10.3 rule dialog errors', () => {
  it('a server refusal with field errors shows each under its field and no form alert', async () => {
    server.use(
      problem(422, {
        code: 'validation_failed',
        errors: [
          { path: '/name', message: 'Name is taken' },
          { path: '/priority', message: 'Priority is out of range' },
        ],
      }),
    );
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await within(dialog).findByText('Name is taken')).toBeInTheDocument();
    expect(within(dialog).getByText('Priority is out of range')).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole('alert')
        .map((x) => x.textContent),
    ).toEqual(['Name is taken', 'Priority is out of range']);
  });

  it('a server refusal without field errors shows one form alert with title and detail', async () => {
    server.use(problem(400, { code: 'rule_invalid', detail: 'The rule cannot be saved' }));
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Refused: The rule cannot be saved');
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
  });

  it('a refused IP range shows an alert that a failed parse of the form replaces', async () => {
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Add an IP range'), 'not-an-ip{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Enter an IP address or a CIDR range',
    );
    await user.clear(within(dialog).getByLabelText(/^Name/));
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await within(dialog).findByText('Name the rule')).toBeInTheDocument();
    expect(within(dialog).queryByText('Enter an IP address or a CIDR range')).toBeNull();
  });

  it('a server refusal also replaces a refused IP range alert', async () => {
    server.use(problem(400, { code: 'rule_invalid', detail: 'No luck' }));
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Add an IP range'), 'not-an-ip{Enter}');
    expect(await within(dialog).findByText('Enter an IP address or a CIDR range')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await within(dialog).findByText(/No luck/)).toBeInTheDocument();
    expect(within(dialog).queryByText('Enter an IP address or a CIDR range')).toBeNull();
  });

  it('a second IP range error keeps the other field errors of the form', async () => {
    const { user, dialog } = await openDialog();
    await user.clear(within(dialog).getByLabelText(/^Name/));
    await user.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    expect(await within(dialog).findByText('Name the rule')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Add an IP range'), 'nope{Enter}');
    expect(await within(dialog).findByText('Enter an IP address or a CIDR range')).toBeVisible();
    expect(within(dialog).getByText('Name the rule')).toBeInTheDocument();
  });
});
