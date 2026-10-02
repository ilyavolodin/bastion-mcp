import type { Me, UiRole } from '@/api/views/session';

export const HOST = 'bastion.acme.dev';

/** The signed-in user of the mock for a UI role (`?as=` picks it in the dev server). */
export const buildMe = (role: UiRole): Me => {
  const orgRole = role === 'admin' ? 'admin' : role === 'auditor' ? 'auditor' : 'member';
  return {
    id: 'u-dana',
    email: 'dana.whitfield@acme.dev',
    name: 'Dana Whitfield',
    orgRole,
    teams: [
      {
        id: 't-platform',
        name: 'Platform team',
        role: role === 'member' || role === 'auditor' ? 'member' : 'manager',
      },
    ],
    theme: 'light',
    org: {
      name: 'Acme Corp',
      host: HOST,
      baseUrl: `https://${HOST}`,
      traceUiUrl: 'https://traces.acme.dev/trace',
      toolWarnThreshold: 40,
    },
    capabilities: {
      registry: role !== 'auditor',
      publishOrgWide: role === 'admin',
      personalInstalls: 'remoteOnly',
    },
  };
};
