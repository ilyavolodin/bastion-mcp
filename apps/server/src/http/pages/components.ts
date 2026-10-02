/** Reusable pieces of the server-rendered pages: fields, buttons, alerts, lists. Every value is escaped by `html`. */
import { type Child, fragment, html, raw, type SafeHtml, safeImageUrl } from './html';

const svg = (paths: string): SafeHtml =>
  raw(
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`,
  );

export const ICONS = {
  error: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>'),
  success: svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>'),
  warning: svg('<path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4.5M12 17.5h.01"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l3 3"/>'),
  building: svg(
    '<path d="M4 21V5l8-2v18M12 8h8v13M4 21h16M8 9h.01M8 13h.01M8 17h.01M16 12h.01M16 16h.01"/>',
  ),
} as const;

export type AlertKind = 'error' | 'info' | 'success' | 'warning';

/**
 * A status message with an icon and a text title, never color alone. Errors use `role="alert"`; the others
 * `role="status"`.
 */
export const alert = (input: { kind: AlertKind; title?: string; body?: Child }): SafeHtml =>
  html`<div class="alert alert-${input.kind}" role="${input.kind === 'error' ? 'alert' : 'status'}">${ICONS[input.kind]}<div class="alert-body">${
    input.title === undefined ? '' : html`<strong class="alert-title">${input.title}</strong>`
  }${input.body === undefined ? '' : html`<p>${input.body}</p>`}</div></div>`;

/**
 * The always-present polite live region of a form: a server-rendered error sits inside it, so assistive
 * technology announces it on load and a script-less page needs nothing more.
 */
export const liveRegion = (id: string, content?: SafeHtml): SafeHtml =>
  html`<div id="${id}" class="live" aria-live="assertive" aria-atomic="true">${content ?? ''}</div>`;

export type FieldSpec = {
  id: string;
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password';
  autocomplete?: string;
  required?: boolean;
  value?: string;
  hint?: string;
  error?: string;
  autofocus?: boolean;
  inputmode?: string;
  minlength?: number;
  /** A link shown beside the label (for example "Forgot password?"). */
  aside?: SafeHtml;
  /** Ids of regions that describe the field (the form error region, for example). */
  describedBy?: readonly string[];
};

export const field = (spec: FieldSpec): SafeHtml => {
  const hintId = `${spec.id}-hint`;
  const errorId = `${spec.id}-error`;
  const describedBy = [
    ...(spec.describedBy ?? []),
    ...(spec.hint ? [hintId] : []),
    ...(spec.error ? [errorId] : []),
  ].join(' ');
  return html`<div class="field"><div class="field-head"><label for="${spec.id}">${spec.label}</label>${spec.aside ?? ''}</div><input id="${spec.id}" name="${spec.name}" type="${spec.type ?? 'text'}"${
    spec.autocomplete ? html` autocomplete="${spec.autocomplete}"` : ''
  }${spec.required ? raw(' required') : ''}${spec.value === undefined ? '' : html` value="${spec.value}"`}${
    spec.autofocus ? raw(' autofocus') : ''
  }${spec.inputmode ? html` inputmode="${spec.inputmode}"` : ''}${
    spec.minlength === undefined ? '' : html` minlength="${spec.minlength}"`
  }${spec.error ? raw(' aria-invalid="true"') : ''}${describedBy ? html` aria-describedby="${describedBy}"` : ''}>${
    spec.hint ? html`<span id="${hintId}" class="hint">${spec.hint}</span>` : ''
  }${spec.error ? html`<span id="${errorId}" class="error-text">${spec.error}</span>` : ''}</div>`;
};

export const hidden = (name: string, value: string): SafeHtml =>
  html`<input type="hidden" name="${name}" value="${value}">`;

export const csrfField = (token: string): SafeHtml => hidden('_csrf', token);

export type ButtonVariant = 'primary' | 'outline' | 'soft' | 'danger';

export const button = (input: {
  label: Child;
  variant?: ButtonVariant;
  type?: 'submit' | 'button';
  name?: string;
  value?: string;
  form?: string;
  icon?: SafeHtml;
}): SafeHtml =>
  html`<button class="btn btn-${input.variant ?? 'primary'}" type="${input.type ?? 'submit'}"${
    input.name === undefined ? '' : html` name="${input.name}"`
  }${input.value === undefined ? '' : html` value="${input.value}"`}${
    input.form === undefined ? '' : html` form="${input.form}"`
  }>${input.icon ?? ''}${input.label}</button>`;

export const linkButton = (input: {
  href: string;
  label: Child;
  variant?: ButtonVariant;
  icon?: SafeHtml;
}): SafeHtml =>
  html`<a class="btn btn-${input.variant ?? 'outline'}" href="${input.href}">${input.icon ?? ''}${input.label}</a>`;

export const link = (href: string, label: Child): SafeHtml => html`<a href="${href}">${label}</a>`;

export const divider = (label: string): SafeHtml =>
  html`<div class="divider" role="separator" aria-label="${label}"><span aria-hidden="true">${label}</span></div>`;

export const stack = (children: readonly Child[]): SafeHtml =>
  html`<div class="stack">${fragment(children)}</div>`;

export const actions = (children: readonly Child[]): SafeHtml =>
  html`<div class="actions">${fragment(children)}</div>`;

export const chip = (text: string): SafeHtml => html`<strong class="chip">${text}</strong>`;

export const codeBlock = (text: string, label: string): SafeHtml =>
  html`<pre class="code-block" role="region" aria-label="${label}"><code>${text}</code></pre>`;

export const orderedSteps = (items: readonly Child[]): SafeHtml =>
  html`<ol class="steps">${items.map((i) => html`<li>${i}</li>`)}</ol>`;

/** A requested-access row: a check icon, the label and an optional plain-language detail. */
export const permissionList = (
  items: readonly { title: string; detail?: string; code?: string }[],
  label: string,
): SafeHtml =>
  html`<ul class="list" aria-label="${label}">${items.map(
    (i) =>
      html`<li>${ICONS.check}<span><span class="item-title">${i.title}</span>${
        i.detail ? html`<span class="item-detail">${i.detail}</span>` : ''
      }${i.code ? html`<code class="item-detail">${i.code}</code>` : ''}</span></li>`,
  )}</ul>`;

const initialOf = (name: string): string => [...name.trim()][0]?.toUpperCase() ?? '?';

/** The client mark of the consent page: its https logo, or its initial on the sunset gradient. */
export const clientAvatar = (name: string, logoUri: unknown): SafeHtml => {
  const logo = safeImageUrl(logoUri);
  return html`<span class="avatar" aria-hidden="true">${
    logo
      ? html`<img src="${logo}" alt="" width="48" height="48" referrerpolicy="no-referrer">`
      : initialOf(name)
  }</span>`;
};
