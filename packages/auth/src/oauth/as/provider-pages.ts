/**
 * Page overrides of oidc-provider (device flow, logout, errors). The ui role supplies the renderers so the pages
 * share Bastion's templates and strict CSP; without them the provider's defaults (which load Google Fonts) apply.
 */
export type ProviderPages = {
  deviceCode(input: { form: string; error?: 'wrong' | 'aborted' | 'other' }): string;
  deviceConfirm(input: {
    clientName: string;
    logoUri: string | null;
    userCode: string;
    form: string;
  }): string;
  deviceSuccess(clientName: string | undefined): string;
  logoutConfirm(form: string): string;
  logoutDone(): string;
  error(input: {
    error: string;
    description: string | undefined;
    details: Record<string, string>;
  }): string;
};

type KoaLike = {
  body?: unknown;
  type?: string;
  oidc: { client?: { clientName?: string; clientId?: string; logoUri?: unknown } };
};

const clientLabel = (ctx: KoaLike): string =>
  ctx.oidc.client?.clientName || ctx.oidc.client?.clientId || 'this app';

const httpsLogo = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

const deviceError = (err: unknown): 'wrong' | 'aborted' | 'other' | undefined => {
  if (!err) return undefined;
  const e = err as { name?: string; userCode?: unknown };
  if (e.userCode || e.name === 'NoCodeError') return 'wrong';
  if (e.name === 'AbortedError') return 'aborted';
  return 'other';
};

/** The `features.deviceFlow` and `features.rpInitiatedLogout` page sources plus `renderError`. */
export const providerPageSources = (pages: ProviderPages) => ({
  deviceFlow: {
    userCodeInputSource: async (ctx: KoaLike, form: string, _out: unknown, err: unknown) => {
      const error = deviceError(err);
      ctx.body = pages.deviceCode({ form, ...(error ? { error } : {}) });
    },
    userCodeConfirmSource: async (
      ctx: KoaLike,
      form: string,
      client: { logoUri?: unknown },
      _deviceInfo: unknown,
      userCode: string,
    ) => {
      ctx.body = pages.deviceConfirm({
        clientName: clientLabel(ctx),
        logoUri: httpsLogo(client.logoUri),
        userCode,
        form,
      });
    },
    successSource: async (ctx: KoaLike) => {
      ctx.body = pages.deviceSuccess(ctx.oidc.client?.clientName || undefined);
    },
  },
  rpInitiatedLogout: {
    logoutSource: async (ctx: KoaLike, form: string) => {
      ctx.body = pages.logoutConfirm(form);
    },
    postLogoutSuccessSource: async (ctx: KoaLike) => {
      ctx.body = pages.logoutDone();
    },
  },
  renderError: async (ctx: KoaLike, out: Record<string, unknown>) => {
    ctx.type = 'html';
    const { error, error_description: description, ...rest } = out;
    ctx.body = pages.error({
      error: String(error ?? 'error'),
      description: typeof description === 'string' ? description : undefined,
      details: Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      ),
    });
  },
});
