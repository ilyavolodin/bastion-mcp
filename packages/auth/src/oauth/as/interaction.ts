import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';
import { CONSENT_TTL_S } from '../constants';
import { buildConsentView, type ConsentView } from './consent';
import { runtime } from './provider-types';

/** What the ui role renders for the current interaction (9.3). */
export type InteractionView =
  | { kind: 'login'; uid: string; clientId: string; loginHint: string | null }
  | { kind: 'consent'; uid: string; consent: ConsentView };

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * The login/consent handoff the ui role implements pages for. Login completes through the IdP login
 * (item 2) and then calls `completeLogin`; consent pages call `completeConsent` or `denyConsent`.
 */
export type InteractionApi = {
  view(req: IncomingMessage, res: ServerResponse): Promise<InteractionView>;
  completeLogin(
    req: IncomingMessage,
    res: ServerResponse,
    input: { userId: string },
  ): Promise<void>;
  completeConsent(
    req: IncomingMessage,
    res: ServerResponse,
    input?: { approvedScopes?: readonly string[] },
  ): Promise<void>;
  denyConsent(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * Ends the provider's own login session of this browser. A person who signs in as somebody else would otherwise
   * hit the provider's "different account" logout step: the account switch must start from a clean session. The
   * pending request ends with it; the result is the query string of the same authorization request, to start again.
   */
  endSession(req: IncomingMessage, res: ServerResponse): Promise<string>;
  abort(
    req: IncomingMessage,
    res: ServerResponse,
    error: string,
    description: string,
  ): Promise<void>;
};

export const createInteractionApi = (current: () => Provider): InteractionApi => ({
  async view(req, res) {
    const provider = current();
    const details = await provider.interactionDetails(req, res);
    const params = asRecord(details.params);
    const clientId = String(params.client_id ?? '');
    if (details.prompt.name === 'login') {
      const hint = params.login_hint;
      return {
        kind: 'login',
        uid: details.uid,
        clientId,
        loginHint: typeof hint === 'string' ? hint : null,
      };
    }
    const client = await provider.Client.find(clientId);
    const prompt = asRecord(details.prompt.details);
    const resources = Object.keys(asRecord(prompt.missingResourceScopes));
    const scopes = [
      ...strings(prompt.missingOIDCScope),
      ...Object.values(asRecord(prompt.missingResourceScopes)).flatMap(strings),
    ];
    return {
      kind: 'consent',
      uid: details.uid,
      consent: buildConsentView({
        clientId,
        clientName: client?.clientName,
        logoUri: client?.logoUri,
        redirectUri: String(params.redirect_uri ?? ''),
        scopes: [...new Set(scopes)],
        resources,
      }),
    };
  },

  async completeLogin(req, res, input) {
    await current().interactionFinished(
      req,
      res,
      { login: { accountId: input.userId } },
      { mergeWithLastSubmission: false },
    );
  },

  async completeConsent(req, res, input = {}) {
    const provider = current();
    const details = await provider.interactionDetails(req, res);
    const accountId = details.session?.accountId;
    if (!accountId) throw new Error('consent requires a logged-in session');
    const approved = input.approvedScopes ? new Set(input.approvedScopes) : null;
    const keep = (scopes: string[]) => (approved ? scopes.filter((s) => approved.has(s)) : scopes);
    const rt = runtime(provider);
    const existing = details.grantId ? await rt.Grant.find(details.grantId) : undefined;
    const grant =
      existing ?? new rt.Grant({ accountId, clientId: String(asRecord(details.params).client_id) });
    const prompt = asRecord(details.prompt.details);
    const oidc = keep(strings(prompt.missingOIDCScope));
    if (oidc.length > 0) grant.addOIDCScope(oidc.join(' '));
    for (const [resource, scopes] of Object.entries(asRecord(prompt.missingResourceScopes))) {
      const list = keep(strings(scopes));
      if (list.length > 0) grant.addResourceScope(resource, list.join(' '));
    }
    const grantId = await grant.save(CONSENT_TTL_S);
    await provider.interactionFinished(
      req,
      res,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  },

  async endSession(req, res) {
    const provider = current();
    const details = await provider.interactionDetails(req, res);
    const uid = (details.session as { uid?: string } | undefined)?.uid;
    if (uid) await (await runtime(provider).Session.findByUid(uid))?.destroy();
    // The pending request dies with the session it belongs to: the same authorization request starts again.
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(asRecord(details.params))) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v === 'string') query.append(name, v);
      }
    }
    return query.toString();
  },

  async denyConsent(req, res) {
    await current().interactionFinished(
      req,
      res,
      { error: 'access_denied', error_description: 'the user denied the request' },
      { mergeWithLastSubmission: false },
    );
  },

  async abort(req, res, error, description) {
    await current().interactionFinished(
      req,
      res,
      { error, error_description: description },
      { mergeWithLastSubmission: false },
    );
  },
});
