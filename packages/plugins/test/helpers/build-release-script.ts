import { buildRelease } from '../../src';
import { marketplaceInfo, RELEASE_TIME, sampleItems } from './items';

/** Child process of the determinism test: prints digests of a two-release chain. */
const ctx = { host: 'mcp.example.com', marketplace: marketplaceInfo };
const first = await buildRelease(sampleItems(), 1, RELEASE_TIME, ctx);
const second = await buildRelease(
  sampleItems().slice(0, 2),
  2,
  new Date(RELEASE_TIME.getTime() + 3_600_000),
  {
    ...ctx,
    parentCommit: first.record.gitCommit,
  },
);
process.stdout.write(
  JSON.stringify({ first: first.record, second: second.record, pid: process.pid }),
);
