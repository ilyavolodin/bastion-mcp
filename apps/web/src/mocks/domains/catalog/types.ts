import type { Schemas } from '@/api/schema';

export type Entry = Schemas['CatalogEntry'];
export type Version = Schemas['CatalogVersion'];
export type Run = Schemas['VersionTestRun'];
export type Policy = Schemas['AutoInstallPolicy'];

/** A file of a skill or plugin version: the row plus its text (the API stores the bytes as a blob). */
export type FileRecord = {
  versionId: string;
  path: string;
  mode: 'file' | 'executable';
  classification: 'plain' | 'executable';
  content: string;
  updatedAt: string;
};

export type CatalogData = {
  entries: Entry[];
  /** Flat, `entryId` on every row. */
  versions: Version[];
  autoInstall: Policy[];
  files: FileRecord[];
  /** `executable_approvals` by version id. */
  approvals: Record<string, { approvedBy: string; approvedAt: string; note: string | null }>;
  /** When the test of a version was started (the mock finishes it a moment later). */
  testStarts: Record<string, number>;
  /** Secrets by `scope/owner/name`: names only, like the real API (values are never kept or returned). */
  secrets: Record<
    string,
    {
      scope: 'org' | 'team' | 'user';
      ownerId: string | null;
      name: string;
      version: number;
      updatedAt: string;
    }
  >;
};
