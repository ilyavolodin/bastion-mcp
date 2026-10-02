import { sha256Hex } from '@bastion-mcp/core';
import type {
  ApiDeps,
  BlobPort,
  ImportedCatalogDraft,
  PackageVersionResolver,
  PluginImportPort,
  VersionTestPort,
  VersionTestRun,
} from '../../../src/ports';
import type { FakeCtx } from '../harness';
import { SEED_FILES } from '../seeds/catalog';

export class MemoryBlobs implements BlobPort {
  readonly blobs = new Map<string, Uint8Array>();
  constructor() {
    for (const text of Object.values(SEED_FILES)) {
      const bytes = new TextEncoder().encode(text);
      this.blobs.set(sha256Hex(bytes), bytes);
    }
  }
  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }
  async get(sha256: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(sha256);
  }
}

export class FakeVersionTests implements VersionTestPort {
  readonly started: Array<{ entryId: string; versionId: string; requestedBy: string }> = [];
  readonly runs = new Map<string, VersionTestRun>();
  async start(input: { entryId: string; versionId: string; requestedBy: string }) {
    this.started.push(input);
    const run: VersionTestRun = {
      id: `run-${this.started.length}`,
      versionId: input.versionId,
      status: 'running',
      steps: [{ id: 'snapshot', status: 'running' }],
      startedAt: '2026-06-01T12:00:00.000Z',
      finishedAt: null,
    };
    this.runs.set(input.versionId, run);
    return run;
  }
  async latest(versionId: string) {
    return this.runs.get(versionId) ?? null;
  }
}

export class FakeImports implements PluginImportPort {
  zipDraft: ImportedCatalogDraft = {
    kind: 'skill',
    name: 'Zip Skill',
    description: 'from zip',
    files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# skill').toString('base64') }],
    warnings: [],
  };
  gitDraft: ImportedCatalogDraft = {
    kind: 'plugin',
    name: 'Git Plugin',
    description: 'from git',
    files: [
      { path: 'SKILL.md', contentBase64: Buffer.from('# skill').toString('base64') },
      { path: 'hooks/hooks.json', contentBase64: Buffer.from('{}').toString('base64') },
    ],
    warnings: ['one warning'],
  };
  async fromZip() {
    return this.zipDraft;
  }
  async fromGit() {
    return this.gitDraft;
  }
}

export const fakeVersionResolver = (): PackageVersionResolver => ({
  async latest(_runtime, identifier) {
    return identifier === 'broken' ? Promise.reject(new Error('offline')) : '1.2.3';
  },
});

export const fakeCatalogDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  catalog: {
    tests: new FakeVersionTests(),
    imports: new FakeImports(),
    versions: fakeVersionResolver(),
    blobs: new MemoryBlobs(),
  },
});
