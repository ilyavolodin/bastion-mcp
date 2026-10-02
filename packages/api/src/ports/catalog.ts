import type { ServerSpec } from '@bastion-mcp/core';
import type { VersionResolver } from '@bastion-mcp/registry';

export type TestStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type VersionTestStep = { id: string; status: TestStepStatus; detail?: string };
export type VersionTestRun = {
  id: string;
  versionId: string;
  status: 'running' | 'passed' | 'failed';
  steps: VersionTestStep[];
  startedAt: string;
  finishedAt: string | null;
};

/** Runs the automatic test of a catalog version (11.2): snapshot, guard scan, OSV, lockfile. */
export interface VersionTestPort {
  start(input: {
    entryId: string;
    versionId: string;
    requestedBy: string;
    /** Values for variables without a default, set on the test installation before the run. */
    variables?: Record<string, string>;
  }): Promise<VersionTestRun>;
  latest(versionId: string): Promise<VersionTestRun | null>;
}

export type ImportedCatalogDraft = {
  kind: 'mcp_server' | 'skill' | 'plugin';
  name: string;
  description?: string;
  spec?: ServerSpec;
  files?: Array<{ path: string; contentBase64: string }>;
  warnings: string[];
};

/** Zip and git imports of skills and plugins (11.1, 25.2); wired to `@bastion-mcp/plugins` by the app. */
export interface PluginImportPort {
  fromZip(bytes: Uint8Array): Promise<ImportedCatalogDraft>;
  fromGit(url: string, ref?: string): Promise<ImportedCatalogDraft>;
}

/** Resolves exact package versions for client-config imports (11.3); same shape as the registry's. */
export type PackageVersionResolver = VersionResolver;

/** Blob bytes of catalog files (`blobs`, 16.2). */
export interface BlobPort {
  put(bytes: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Uint8Array | undefined>;
}
