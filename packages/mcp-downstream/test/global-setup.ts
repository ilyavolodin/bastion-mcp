import { dockerAvailable } from '@bastion-mcp/testkit';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Whether a Docker daemon answered once, before any worker started (probing from every file races under load). */
    docker: boolean;
  }
}

/** Probes Docker once for the whole run; each integration file reads the verdict instead of probing itself. */
export default function setup(project: TestProject): void {
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) ok = dockerAvailable();
  project.provide('docker', ok);
}
