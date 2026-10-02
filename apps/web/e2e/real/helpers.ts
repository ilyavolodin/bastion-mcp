import { expect, type Page } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 18080);
const CONTROL = `http://localhost:${PORT + 1}`;

export type StackState = {
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
  upstreamUrl: string;
};

export const state = async (): Promise<StackState> =>
  (await (await fetch(`${CONTROL}/state`)).json()) as StackState;

const post = async (path: string, body: unknown): Promise<unknown> =>
  (
    await fetch(`${CONTROL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();

/** Creates (or resets the password of) a member who can sign in with a local password. */
export const makeUser = (email: string, password: string, name = email) =>
  post('/make-user', { email, password, name }) as Promise<{ id: string; email: string }>;

/** What the fake remote server received from the gateway: one row per HTTP request. */
export const upstreamRequests = async (): Promise<
  { method: string; authorization: string | null; apiKey: string | null; rpc: string | null }[]
> => (await (await fetch(`${CONTROL}/upstream/requests`)).json()) as never;

export const requireUpstreamToken = (token: string | null) => post('/upstream/token', { token });

export const resetUpstream = () => post('/upstream/reset', {});

/** Signs in through the real login page with a local password. */
export const signIn = async (page: Page, email: string, password: string): Promise<void> => {
  await page.goto('/auth/login?return_to=/');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
};

export const signInAdmin = async (page: Page): Promise<void> => {
  const s = await state();
  await signIn(page, s.adminEmail, s.adminPassword);
};

export const goStep = async (page: Page, name: string | RegExp): Promise<void> => {
  await page
    .getByRole('navigation', { name: 'Catalog steps' })
    .getByRole('button', { name })
    .click();
};

/** The cookie double-submit token the SPA sends as `x-bastion-csrf`. */
export const csrfOf = async (page: Page): Promise<string> =>
  (await page.context().cookies()).find((c) => c.name === 'bastion_csrf')?.value ?? '';

/** An API call as the signed-in browser session (cookie plus CSRF header). */
export const apiCall = async (
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> => {
  const response = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-bastion-csrf': await csrfOf(page),
      'idempotency-key': Math.random().toString(36).slice(2),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status(), body: text ? JSON.parse(text) : null };
};

/** Fills the Source step of a new entry. */
export const fillSource = async (
  page: Page,
  input: { name: string } & (
    | { kind: 'remote'; url: string }
    | { kind: 'npm'; identifier: string; version?: string }
  ),
): Promise<void> => {
  await page.goto('/catalog/new');
  await page.getByLabel('Display name').fill(input.name);
  if (input.kind === 'remote') {
    await page.getByLabel('Runtime').selectOption('remote');
    await page.getByLabel('Server URL').fill(input.url);
  } else {
    await page.getByLabel('Package').fill(input.identifier);
    if (input.version) await page.getByLabel('Version', { exact: true }).fill(input.version);
  }
};

/** Saves the draft and waits for the entry to exist (the URL carries its id). */
export const saveDraft = async (page: Page): Promise<string> => {
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.waitForURL(/\/catalog\/[0-9a-f-]{36}/, { timeout: 30_000 });
  return /\/catalog\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
};

/** A name and its URL name that do not collide when the specs run again against the same stack. */
export const unique = (base: string): { name: string; slug: string } => {
  const name = `${base} ${Math.random().toString(36).slice(2, 7)}`;
  return { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') };
};

/** Waits until a test passes and the editor moves on to Publish; a failed test fails with its reason. */
export const expectPublishReady = async (page: Page, timeout = 90_000): Promise<void> => {
  const ready = page.getByRole('heading', { name: 'Ready to publish' });
  const failed = page.getByRole('alert').filter({ hasText: 'The test failed' });
  await expect(ready.or(failed)).toBeVisible({ timeout });
  if (await failed.isVisible()) {
    const steps = await page.getByRole('list', { name: 'Test steps' }).innerText();
    throw new Error(`The test failed:\n${await failed.innerText()}\n${steps}`);
  }
};
