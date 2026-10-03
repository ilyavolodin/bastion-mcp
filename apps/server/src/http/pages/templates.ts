/**
 * The server-rendered pages as typed functions that return escaped HTML (9.1 to 9.6). Every page is built from the
 * shared `renderPage` layout and `components`; nothing in here concatenates user data into markup by hand.
 */
import {
  actions,
  alert,
  button,
  chip,
  clientAvatar,
  codeBlock,
  csrfField,
  divider,
  field,
  hidden,
  ICONS,
  link,
  linkButton,
  liveRegion,
  orderedSteps,
  permissionList,
  stack,
} from './components';
import { type Child, html, raw, type SafeHtml } from './html';
import { renderPage } from './layout';

export type PageMessage = {
  kind: 'error' | 'info' | 'warning' | 'success';
  title: string;
  body?: string;
};

const FORM_STATUS = 'form-status';

const messageRegion = (message: PageMessage | undefined): SafeHtml =>
  liveRegion(
    FORM_STATUS,
    message
      ? alert({
          kind: message.kind,
          title: message.title,
          ...(message.body === undefined ? {} : { body: message.body }),
        })
      : undefined,
  );

// --- login (9.1) -----------------------------------------------------------------------------------------------

export type LoginPageInput = {
  /** Where to go after signing in; a same-origin path (already checked by the route). */
  returnTo: string;
  /** Enabled IdP connections. */
  connections: readonly { id: string; name: string }[];
  /** Local password login is enabled (9.1: no IdP exists, or `BASTION_LOCAL_LOGIN=true`). */
  local: { enabled: boolean; csrf: string; email?: string | undefined };
  message?: PageMessage | undefined;
  /** The OAuth client the user is signing in for (interaction pages). */
  forClient?: string | undefined;
};

const idpHref = (id: string, returnTo: string): string =>
  `/auth/login?connection=${encodeURIComponent(id)}&return_to=${encodeURIComponent(returnTo)}`;

/** Sign in: IdP buttons, routing by e-mail domain when several exist, and the break-glass password form. */
export const loginPage = (input: LoginPageInput): string => {
  const { connections, local, returnTo, message } = input;
  const hasIdp = connections.length > 0;
  const localForm = local.enabled
    ? html`<form method="post" action="/auth/local" novalidate>${csrfField(local.csrf)}${hidden('return_to', returnTo)}${field(
        {
          id: 'local-email',
          name: 'email',
          label: 'Email',
          type: 'email',
          autocomplete: 'username',
          required: true,
          value: local.email ?? '',
          autofocus: message === undefined || message.kind !== 'error' || !local.email,
          describedBy: message?.kind === 'error' ? [FORM_STATUS] : [],
        },
      )}${field({
        id: 'local-password',
        name: 'password',
        label: 'Password',
        type: 'password',
        autocomplete: 'current-password',
        required: true,
        autofocus: message?.kind === 'error' && Boolean(local.email),
        describedBy: message?.kind === 'error' ? [FORM_STATUS] : [],
        aside: link('/auth/forgot', 'Forgot password?'),
      })}${button({ label: 'Sign in', variant: hasIdp ? 'outline' : 'primary' })}</form>`
    : '';
  const routing =
    connections.length > 1
      ? html`<form method="get" action="/auth/login">${hidden('return_to', returnTo)}${field({
          id: 'sso-email',
          name: 'email',
          label: 'Work email',
          type: 'email',
          autocomplete: 'email',
          hint: 'We send you to your organization’s sign-in based on your email domain.',
        })}${button({ label: 'Continue with single sign-on' })}</form>${divider('or choose a provider')}`
      : '';
  const providers = hasIdp
    ? stack(
        connections.map((c) =>
          linkButton({
            href: idpHref(c.id, returnTo),
            label: `Sign in with ${c.name}`,
            variant: connections.length > 1 ? 'outline' : 'primary',
            icon: ICONS.building,
          }),
        ),
      )
    : '';
  const disabledNote =
    hasIdp && !local.enabled
      ? alert({
          kind: 'info',
          title: 'Password sign-in is turned off',
          body: 'This organization signs in through single sign-on. Use the button above. Administrators can re-enable the local account with BASTION_LOCAL_LOGIN=true.',
        })
      : '';
  const nothing =
    !hasIdp && !local.enabled
      ? alert({
          kind: 'warning',
          title: 'No sign-in method is available',
          body: 'No identity provider is enabled and local sign-in is off. Ask an administrator to set BASTION_LOCAL_LOGIN=true or to enable an identity provider.',
        })
      : '';
  return renderPage({
    title: 'Sign in',
    heading: 'Sign in to Bastion',
    lede: input.forClient
      ? html`Sign in to continue to <strong>${input.forClient}</strong>.`
      : hasIdp
        ? 'Use your organization account to continue.'
        : 'Sign in to continue.',
    body: html`${messageRegion(message)}${routing}${providers}${hasIdp && local.enabled ? divider('or use a local account') : ''}${localForm}${disabledNote}${nothing}`,
  });
};

/** Explains the password reset options of a self-hosted deployment (9.1: no e-mail delivery in v1). */
export const forgotPasswordPage = (input: {
  idpNames: readonly string[];
  localEnabled: boolean;
  /** Public host, used in the example commands only as text. */
  host: string;
}): string => {
  const hasIdp = input.idpNames.length > 0;
  return renderPage({
    title: 'Forgot password',
    heading: 'Forgot your password?',
    wide: true,
    lede: 'Bastion does not send email, so a password is reset by the person who runs it.',
    body: html`${
      hasIdp
        ? html`<h2>Signing in through single sign-on</h2><p>If you sign in with ${input.idpNames.join(', ')}, reset your password with that identity provider. Bastion never sees it.</p>`
        : ''
    }<h2>Local administrator account</h2>${
      input.localEnabled
        ? ''
        : alert({
            kind: 'info',
            title: 'Password sign-in is currently off',
            body: 'It is available only while no identity provider exists, or when BASTION_LOCAL_LOGIN=true.',
          })
    }${orderedSteps([
      html`If you are signed in, open the account menu and choose <strong>Change password</strong>.`,
      'Otherwise ask an administrator who can run commands on the server. They can set a new password with:',
    ])}${codeBlock('bastion reset-password --email you@example.com', 'Command to reset a password')}<p>With Docker Compose:</p>${codeBlock(
      'docker compose exec bastion bastion reset-password --email you@example.com',
      'Docker Compose command to reset a password',
    )}<p class="muted">The command prints a new random password once and signs the account out everywhere. Add <code>--password-stdin</code> to set a password you choose.</p>${actions([linkButton({ href: '/auth/login', label: 'Back to sign in', variant: 'outline' })])}`,
  });
};

// --- OAuth consent (9.3) ----------------------------------------------------------------------------------------

const SCOPE_TEXT: Record<string, { title: string; detail: string }> = {
  mcp: {
    title: 'Use your MCP servers through Bastion',
    detail: 'Call the tools, prompts and resources you are allowed to use.',
  },
  'api:read': {
    title: 'Read your Bastion data',
    detail: 'See your servers, activity and settings.',
  },
  'api:write': {
    title: 'Change your Bastion data',
    detail: 'Create and update things on your behalf.',
  },
  'plugins:read': {
    title: 'Download your plugins and skills',
    detail: 'Fetch the plugins your organization offers you.',
  },
  offline_access: {
    title: 'Stay signed in',
    detail: 'Keep access until you revoke it, without asking again.',
  },
};

/** Who is signed in to this browser, as the pages name them. */
export type AccountView = { name: string; email: string };

const accountLine = (account: AccountView) =>
  html`<p class="account" aria-label="Signed in as">Signed in as <strong>${account.name}</strong>${
    account.name === account.email ? '' : html` <span class="muted">(${account.email})</span>`
  }</p>`;

export type AccountChooserInput = {
  uid: string;
  csrf: string;
  /** The OAuth client id: a URL for client ID metadata documents, an opaque id for registered clients. */
  clientId: string;
  account: AccountView;
};

/**
 * Shown when the browser is already signed in to Bastion and an app asks for access (9.3): the app is authorized as
 * the account named here, so the person confirms it, or signs in as somebody else, before anything is granted.
 */
export const accountChooserPage = (input: AccountChooserInput): string =>
  renderPage({
    title: 'Which account?',
    body: html`<p>An app (<code>${input.clientId}</code>) wants to use Bastion. Which account should it use?</p>${accountLine(input.account)}<form method="post" action="/oauth/interaction/${encodeURIComponent(input.uid)}/continue">${csrfField(input.csrf)}${actions(
      [button({ label: html`Continue as ${input.account.name}`, variant: 'primary' })],
    )}</form><form method="post" action="/oauth/interaction/${encodeURIComponent(input.uid)}/switch">${csrfField(input.csrf)}${actions(
      [button({ label: 'Use a different account', variant: 'outline' })],
    )}</form>`,
    footnote: 'The app acts with this account’s access and its activity is recorded under it.',
  });

export type ConsentPageInput = {
  uid: string;
  csrf: string;
  clientName: string;
  logoUri: string | null;
  redirectHost: string;
  scopes: readonly string[];
  /** The account the app is being authorized as. */
  account: AccountView;
};

/** Consent: the client, where the user returns to (spec MUST), what it asks for, Allow or Deny. */
export const consentPage = (input: ConsentPageInput): string =>
  renderPage({
    title: 'Authorize access',
    body: html`<div class="client">${clientAvatar(input.clientName, input.logoUri)}<div><span class="client-name">${input.clientName}</span><span class="caption block">wants to access your Bastion account</span></div></div>${accountLine(input.account)}<p>After you decide, you will be sent back to ${chip(input.redirectHost)}</p><span class="overline" id="scopes-label">It is asking to</span>${
      input.scopes.length > 0
        ? permissionList(
            input.scopes.map((s) => ({
              title: SCOPE_TEXT[s]?.title ?? s,
              ...(SCOPE_TEXT[s] ? { detail: SCOPE_TEXT[s].detail } : {}),
              code: s,
            })),
            'Requested access',
          )
        : html`<p class="muted">No additional access beyond signing in.</p>`
    }<form method="post" action="/oauth/interaction/${encodeURIComponent(input.uid)}/consent">${csrfField(input.csrf)}${actions(
      [
        button({ label: 'Allow', variant: 'primary', name: 'decision', value: 'approve' }),
        button({ label: 'Deny', variant: 'outline', name: 'decision', value: 'deny' }),
      ],
    )}</form>`,
    footnote: 'Only allow apps you trust. You can revoke access later from your account.',
  });

// --- upstream connect (9.6) -------------------------------------------------------------------------------------

export type ConnectPageInput = {
  installationId: string;
  installationName: string;
  authorizationServerHost: string;
  scopes: readonly string[];
  csrf: string;
};

/** Consent before the redirect to the upstream authorization server, naming its host. */
export const connectPage = (input: ConnectPageInput): string =>
  renderPage({
    title: `Connect ${input.installationName}`,
    body: html`<p>Bastion will send you to ${chip(input.authorizationServerHost)} to sign in to <strong>${input.installationName}</strong> with your own account.</p>${
      input.scopes.length > 0
        ? html`<span class="overline">Requested access</span>${permissionList(
            input.scopes.map((s) => ({ title: s })),
            'Requested access',
          )}`
        : ''
    }<form method="post" action="/connect/${encodeURIComponent(input.installationId)}">${csrfField(input.csrf)}${actions(
      [
        button({ label: html`Continue to ${input.authorizationServerHost}` }),
        linkButton({
          href: `/servers/${encodeURIComponent(input.installationId)}`,
          label: 'Cancel',
          variant: 'outline',
        }),
      ],
    )}</form>`,
    footnote: 'You will approve access on the other site. Bastion stores the result encrypted.',
  });

// --- errors -----------------------------------------------------------------------------------------------------

export type ErrorPageInput = {
  message: string;
  title?: string;
  /** A way out; defaults to the console. */
  back?: { href: string; label: string };
  /** Extra detail lines (the provider's error code and description). */
  details?: readonly { name: string; value: string }[];
};

export const errorPage = (input: ErrorPageInput): string =>
  renderPage({
    title: input.title ?? 'Something went wrong',
    body: html`${alert({ kind: 'error', title: 'This request could not be completed', body: input.message })}${
      input.details && input.details.length > 0
        ? html`<dl class="muted">${input.details.map((d) => html`<dt class="caption">${d.name}</dt><dd class="mono">${d.value}</dd>`)}</dl>`
        : ''
    }${actions([linkButton({ href: input.back?.href ?? '/', label: input.back?.label ?? 'Back to Bastion', variant: 'outline' })])}`,
  });

// --- device flow and logout pages of the authorization server (9.3) ---------------------------------------------

/**
 * Gives the provider-built user code form a label and removes its inline `onfocus` handler (the CSP forbids inline
 * scripts). Falls back to the untouched form when the provider markup changes.
 */
const prepareDeviceInputForm = (form: string): SafeHtml => {
  const cleaned = form
    .replace(/\sonfocus="[^"]*"/, '')
    .replace(
      /type="text" name="user_code"/,
      'type="text" name="user_code" id="user_code" class="code-input" spellcheck="false" autocapitalize="characters" aria-describedby="form-status"',
    );
  return raw(cleaned);
};

export const deviceCodePage = (input: {
  form: string;
  error?: 'wrong' | 'aborted' | 'other';
}): string => {
  const message: PageMessage | undefined =
    input.error === 'wrong'
      ? {
          kind: 'error',
          title: 'That code is not right',
          body: 'Check the code on your device and try again.',
        }
      : input.error === 'aborted'
        ? {
            kind: 'error',
            title: 'The request was interrupted',
            body: 'Start again from your device.',
          }
        : input.error === 'other'
          ? {
              kind: 'error',
              title: 'We could not process that code',
              body: 'Try again, or start again from your device.',
            }
          : undefined;
  return renderPage({
    title: 'Connect a device',
    lede: 'Enter the code shown on your device.',
    body: html`${messageRegion(message)}<div class="field"><label for="user_code">Device code</label></div>${prepareDeviceInputForm(input.form)}<div class="actions">${button({ label: 'Continue', form: 'op.deviceInputForm' })}</div>`,
  });
};

export const deviceConfirmPage = (input: {
  clientName: string;
  logoUri: string | null;
  userCode: string;
  /** The provider's confirm form (hidden fields only), referenced by the buttons through `form=`. */
  form: string;
}): string =>
  renderPage({
    title: 'Confirm device',
    lede: 'Check that this code matches the one on your device.',
    body: html`<div class="client">${clientAvatar(input.clientName, input.logoUri)}<span class="client-name">${input.clientName}</span></div><p class="usercode" aria-label="Device code">${input.userCode}</p>${raw(input.form)}<p class="muted">If you did not start this on a device you own, or the code does not match, choose Cancel.</p>${actions(
      [
        button({ label: 'Continue', form: 'op.deviceConfirmForm' }),
        button({
          label: 'Cancel',
          variant: 'outline',
          form: 'op.deviceConfirmForm',
          name: 'abort',
          value: 'yes',
        }),
      ],
    )}`,
  });

export const deviceSuccessPage = (clientName: string | undefined): string =>
  renderPage({
    title: 'Device connected',
    body: html`${alert({
      kind: 'success',
      title: 'You are signed in',
      body: clientName
        ? `Your sign-in with ${clientName} was successful.`
        : 'Your sign-in was successful.',
    })}<p>You can close this page and return to your device.</p>`,
  });

export const logoutConfirmPage = (form: string): string =>
  renderPage({
    title: 'Sign out',
    lede: 'Do you want to sign out of Bastion?',
    body: html`${raw(form)}${actions([
      button({ label: 'Yes, sign me out', form: 'op.logoutForm', name: 'logout', value: 'yes' }),
      button({ label: 'Stay signed in', variant: 'outline', form: 'op.logoutForm' }),
    ])}`,
  });

export const logoutDonePage = (): string =>
  renderPage({
    title: 'Signed out',
    body: html`${alert({ kind: 'success', title: 'You are signed out' })}${actions([
      linkButton({ href: '/auth/login', label: 'Sign in again', variant: 'primary' }),
    ])}`,
  });

export type { Child };
