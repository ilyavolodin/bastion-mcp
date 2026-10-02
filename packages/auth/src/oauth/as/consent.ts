/** Consent page content (9.3): client name, logo, redirect URI host (spec MUST) and scopes. */
export type ConsentView = {
  clientId: string;
  clientName: string;
  logoUri: string | null;
  redirectUri: string;
  /** Host the user will be sent back to; for private-use schemes the scheme itself. */
  redirectUriHost: string;
  scopes: string[];
  resources: string[];
};

export const redirectUriHostLabel = (redirectUri: string): string => {
  try {
    const url = new URL(redirectUri);
    return url.host !== '' ? url.host : url.protocol;
  } catch {
    return 'unknown';
  }
};

const safeLogo = (logoUri: unknown): string | null => {
  if (typeof logoUri !== 'string') return null;
  try {
    return new URL(logoUri).protocol === 'https:' ? logoUri : null;
  } catch {
    return null;
  }
};

export const buildConsentView = (input: {
  clientId: string;
  clientName?: string | undefined;
  logoUri?: unknown;
  redirectUri: string;
  scopes: readonly string[];
  resources: readonly string[];
}): ConsentView => ({
  clientId: input.clientId,
  clientName: input.clientName && input.clientName.length > 0 ? input.clientName : input.clientId,
  logoUri: safeLogo(input.logoUri),
  redirectUri: input.redirectUri,
  redirectUriHost: redirectUriHostLabel(input.redirectUri),
  scopes: [...input.scopes],
  resources: [...input.resources],
});
