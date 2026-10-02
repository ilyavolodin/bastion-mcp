import type { ProviderPages } from '@bastion-mcp/auth';
import {
  deviceCodePage,
  deviceConfirmPage,
  deviceSuccessPage,
  errorPage,
  logoutConfirmPage,
  logoutDonePage,
} from './templates';

/** The pages oidc-provider serves itself, rendered with Bastion's templates (9.3). */
export const bastionProviderPages: ProviderPages = {
  deviceCode: (input) => deviceCodePage(input),
  deviceConfirm: (input) => deviceConfirmPage(input),
  deviceSuccess: (clientName) => deviceSuccessPage(clientName),
  logoutConfirm: (form) => logoutConfirmPage(form),
  logoutDone: () => logoutDonePage(),
  error: ({ error, description, details }) =>
    errorPage({
      title: 'Request failed',
      message: description ?? 'The request could not be completed.',
      details: [
        { name: 'error', value: error },
        ...Object.entries(details).map(([name, value]) => ({ name, value })),
      ],
    }),
};
