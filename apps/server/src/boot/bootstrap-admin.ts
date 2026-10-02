import { bootstrapAdmin } from '@bastion-mcp/auth';
import type { Infra } from '../infra';

export type PrintPassword = (email: string, password: string) => void;

/** Prints the one-time block on stdout. Never routed through the logger (22.3). */
export const printToStdout: PrintPassword = (email, password) => {
  process.stdout.write(
    [
      '',
      '==================== BASTION BOOTSTRAP ADMIN ====================',
      ` email:    ${email}`,
      ` password: ${password}`,
      ' This password is shown once. Change it after the first login.',
      '=================================================================',
      '',
    ].join('\n'),
  );
};

/**
 * `BASTION_BOOTSTRAP_ADMIN_EMAIL` (9.1): creates the local admin once. A generated password is handed to `print`
 * exactly once; a second run finds the user and creates nothing.
 */
export const bootstrapAdminUser = async (
  infra: Infra,
  print: PrintPassword = infra.options.printBootstrapPassword ?? printToStdout,
  input: { email?: string | undefined; password?: string | undefined } = {},
): Promise<{ created: boolean; email?: string }> => {
  const email = input.email ?? infra.config.bootstrapAdminEmail;
  if (!email) return { created: false };
  const result = await bootstrapAdmin(
    { users: infra.repos.localAdmins },
    { email, ...(input.password === undefined ? {} : { password: input.password }) },
  );
  if (result.created && result.generatedPassword && result.email) {
    print(result.email, result.generatedPassword);
  }
  if (result.created) infra.logger.info({ email: result.email }, 'bootstrap admin created');
  return { created: result.created, ...(result.email ? { email: result.email } : {}) };
};
