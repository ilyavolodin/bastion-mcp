import { dockerAvailable } from '@bastion-mcp/testkit';
import { inject } from 'vitest';

/** The verdict of `test/global-setup.ts`; falls back to probing when a file runs outside the configured project. */
export const hasDocker = (): boolean => {
  try {
    return inject('docker');
  } catch {
    return dockerAvailable();
  }
};
