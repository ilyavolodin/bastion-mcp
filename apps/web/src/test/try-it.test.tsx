import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { captureRequests, expectSent } from './capture';
import { renderRoute } from './utils';

/**
 * Try it (12.5): the panel asks for what the definition itself declares. A tool's input schema gives the fields, a
 * prompt its arguments, a template its variables, and nothing is invented for the person to start from.
 */

const open = async () => {
  const view = await renderRoute('/servers/i-postgres?tab=overrides');
  const panel = within(await screen.findByRole('region', { name: 'Try it' }));
  // The definitions arrive with the override preview.
  await waitFor(() => expect(panel.getByLabelText('Tool')).toHaveValue('pg_run_query'));
  return { ...view, panel };
};

describe('Try it asks for what the definition declares (12.5)', () => {
  it('a tool’s input schema gives the fields: required first and marked, defaults filled, nothing made up', async () => {
    const { user, panel } = await open();
    await user.selectOptions(panel.getByLabelText('Tool'), 'pg_run_query');
    // sql is required and starts empty; limit starts at the schema's own default; the rest is not set.
    const sql = await panel.findByLabelText('sql *');
    expect(sql).toHaveValue('');
    expect(panel.getByLabelText('limit')).toHaveValue(100);
    expect(panel.getByLabelText('explain')).toHaveValue('');
    expect(panel.getByLabelText('params')).toHaveValue('');
    expect(panel.getByText('The SELECT statement to run')).toBeVisible();
    // The old panel started every tool with { "query": "orders" }.
    expect(panel.queryByDisplayValue(/orders/)).toBeNull();
    // required parameters come before optional ones
    const labels = panel.getAllByLabelText(/^(sql \*|limit|explain|params)$/).map((e) => e.id);
    expect(labels[0]).toBe(sql.id);
  });

  it('a required parameter without a value is named, and nothing is sent', async () => {
    const capture = captureRequests();
    const { user, panel } = await open();
    await user.selectOptions(panel.getByLabelText('Tool'), 'pg_run_query');
    await user.click(await panel.findByRole('button', { name: 'Run' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('sql is required');
    expect(capture.calls.some((c) => c.path.endsWith('/try'))).toBe(false);
    capture.stop();
  });

  it('typed values become typed arguments: numbers, booleans, a choice, a list', async () => {
    const capture = captureRequests();
    const { user, panel } = await open();
    await user.selectOptions(panel.getByLabelText('Tool'), 'pg_run_query');
    await user.type(await panel.findByLabelText('sql *'), 'select 1');
    const limit = panel.getByLabelText('limit');
    await user.clear(limit);
    await user.type(limit, '5');
    await user.selectOptions(panel.getByLabelText('explain'), 'true');
    await user.type(panel.getByLabelText('params'), 'a{Enter}b');
    await user.click(panel.getByRole('button', { name: 'Run' }));
    const sent = await capture.next('post', '/try');
    expect(sent.body).toEqual({
      kind: 'tool',
      name: 'pg_run_query',
      arguments: { sql: 'select 1', limit: 5, explain: true, params: ['a', 'b'] },
    });
    // The answer is shown as text, with the raw response one click away.
    expect(await panel.findByText('2 rows')).toBeVisible();
    expect(panel.getByText('Succeeded')).toBeVisible();
    expect(panel.getByText('Raw response')).toBeVisible();
    capture.stop();
  });

  it('a choice from the schema’s own values starts on the first one when it is required', async () => {
    const { user, panel } = await open();
    await user.selectOptions(panel.getByLabelText('Tool'), 'pg_describe_table');
    // pg_describe_table: schema is a required enum.
    expect(await panel.findByLabelText('schema *')).toHaveValue(JSON.stringify('public'));
    expect(panel.getByLabelText('table *')).toHaveValue('');
  });

  it('the JSON view starts from the same arguments, rejects text that is not an object, and notes unknown names', async () => {
    const capture = captureRequests();
    const { user, panel } = await open();
    await user.selectOptions(panel.getByLabelText('Tool'), 'pg_run_query');
    await user.click(panel.getByRole('button', { name: 'JSON' }));
    const editor = await panel.findByLabelText('Arguments (JSON)');
    expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual({ limit: 100 });
    fireEvent.change(editor, { target: { value: '[1]' } });
    expect(await panel.findByRole('alert')).toHaveTextContent('must be a JSON object');
    await user.click(panel.getByRole('button', { name: 'Run' }));
    expect(capture.calls.some((c) => c.path.endsWith('/try'))).toBe(false);

    fireEvent.change(editor, { target: { value: '{"sql":"select 2","typo":1}' } });
    expect(await panel.findByRole('note')).toHaveTextContent('does not declare “typo”');
    await user.click(panel.getByRole('button', { name: 'Run' }));
    const sent = await capture.next('post', '/try');
    expect(sent.body).toMatchObject({ arguments: { sql: 'select 2', typo: 1 } });
    capture.stop();
  });

  it('a prompt asks for its declared arguments, requires the required ones and shows its messages', async () => {
    const capture = captureRequests();
    const { user, panel } = await open();
    await user.click(panel.getByRole('button', { name: /^Prompts/ }));
    expect(await panel.findByLabelText('team *')).toHaveValue('');
    expect(panel.getByLabelText('week')).toBeVisible();
    expect(panel.getByText('ISO week, for example 2026-W40')).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'Get prompt' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('team is required');
    await user.type(panel.getByLabelText('team *'), 'data');
    await user.click(panel.getByRole('button', { name: 'Get prompt' }));
    const sent = await capture.next('post', '/try');
    expect(sent.body).toEqual({
      kind: 'prompt',
      name: 'weekly_metrics',
      arguments: { team: 'data' },
    });
    // The messages are shown with their role.
    expect(await panel.findByText('user')).toBeVisible();
    expect(panel.getByText('Summarize the numbers (team=data).')).toBeVisible();
    capture.stop();
  });

  it('a resource is read by its URI; a template asks for its variables and shows the URI it builds', async () => {
    const capture = captureRequests();
    const { user, panel } = await open();
    await user.click(panel.getByRole('button', { name: /^Resources/ }));
    const picker = await panel.findByLabelText('Resource');
    // The plain resource first: its URI is known, nothing to fill in.
    expect(panel.getByText(/URI to read/).parentElement).toHaveTextContent('pg://catalog/tables');
    await user.click(panel.getByRole('button', { name: 'Read' }));
    expect((await capture.next('post', '/try')).body).toEqual({
      kind: 'resource',
      uri: 'pg://catalog/tables',
    });
    expect(await panel.findByText('contents of pg://catalog/tables')).toBeVisible();

    // The template: its two variables, and the URI they make.
    await user.selectOptions(picker, 'pg://{schema}/{table}');
    await user.type(await panel.findByLabelText('schema'), 'public');
    await user.type(panel.getByLabelText('table'), 'orders');
    expect(panel.getByText(/URI to read/).parentElement).toHaveTextContent('pg://public/orders');
    await user.click(panel.getByRole('button', { name: 'Read' }));
    await waitFor(() =>
      expect(capture.calls.filter((c) => c.path.endsWith('/try')).at(-1)?.body).toEqual({
        kind: 'resource',
        uri: 'pg://public/orders',
      }),
    );
    capture.stop();
  });
});

describe('The Overrides tab leads with what is shown (12.5)', () => {
  it('12.5 a switch hides a tool, and saving sends it as hidden', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    const shown = await screen.findByLabelText('Show pg_explain');
    await user.click(shown);
    await waitFor(() => expect(shown).not.toBeChecked());
    await user.click(screen.getByRole('button', { name: 'Save overrides' }));
    const body = (await expectSent(capture, 'put', '/installations/i-postgres/overrides')) as {
      tools?: Record<string, unknown>;
    };
    expect(body.tools?.pg_explain).toEqual({ hidden: true });
    capture.stop();
  });

  it('12.5 search narrows the list', async () => {
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    await screen.findByLabelText('Show pg_explain');
    await user.type(screen.getByLabelText('Search items'), 'explain');
    expect(screen.queryByLabelText('Show pg_run_query')).toBeNull();
    expect(screen.getByLabelText('Show pg_explain')).toBeInTheDocument();
  });
});

describe('Overrides for everyone who installs a server (12.5)', () => {
  it('12.5 an Admin applies a change to every installation, saved on the catalog entry', async () => {
    const capture = captureRequests();
    const { user } = await renderRoute('/servers/i-postgres?tab=overrides');
    await user.click(
      await screen.findByRole('button', { name: 'Everyone who installs this server' }),
    );
    const shown = await screen.findByLabelText('Show pg_explain');
    await user.click(shown);
    await user.click(screen.getByRole('button', { name: 'Save overrides' }));
    const sent = await expectSent(capture, 'put', '/catalog/c-postgres/default-overrides');
    expect(sent).toMatchObject({ tools: { pg_explain: { hidden: true } } });
    capture.stop();
  });
});
