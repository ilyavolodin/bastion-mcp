import { MS, SECONDS, TIMEOUTS_MS } from '@bastion-mcp/core';

/** Timeouts, intervals and sizes of the server process, in one place. */

/** How long a worker waits for the ui role to create the signing and state keys. */
export const KEYS_WAIT_MS = MS.MINUTE;
export const KEYS_POLL_MS = MS.SECOND;

/** Live upstream listing: total wait for a cold start, pause between attempts. */
export const UPSTREAM_LIST_TIMEOUT_MS = 2 * MS.MINUTE;
export const UPSTREAM_LIST_POLL_MS = MS.SECOND;
/** The catalog TEST flow allows a little longer than a plain listing (npm install, image pull). */
export const VERSION_TEST_LIST_TIMEOUT_MS = 150 * MS.SECOND;
/** The catalog TEST flow gives up on a run that has not finished after this long (it died with its process). */
export const VERSION_TEST_STALE_AFTER_MS = 15 * MS.MINUTE;
/** An upstream call made by the API on behalf of the UI (test connection, try). */
export const API_UPSTREAM_CALL_TIMEOUT_MS = MS.MINUTE;

/** Scheduler leader election: retry period of a follower. */
export const SCHEDULER_LEADER_RETRY_MS = 5 * MS.SECOND;
export const SCHEDULER_KEEPALIVE_MS = 2 * MS.SECOND;
/** graphile-worker poll interval. */
export const SCHEDULER_POLL_MS = MS.SECOND;

/** In-flight work a worker waits for on shutdown (21.2), and the hard kill that follows with slack. */
export const DRAIN_GRACE_MS = TIMEOUTS_MS.graceful;
export const HARD_KILL_SLACK_MS = 10 * MS.SECOND;
export const HARD_KILL_MS = DRAIN_GRACE_MS + HARD_KILL_SLACK_MS;

/** Connection timeout of the CLI's database and Redis probes. */
export const CLI_CONNECT_TIMEOUT_MS = 5 * MS.SECOND;
/** Interactive transaction of `import-config`. */
export const CONFIG_IMPORT_TX_OPTIONS = {
  timeout: 2 * MS.MINUTE,
  maxWait: 10 * MS.SECOND,
} as const;

/** Per-check timeout of the health endpoints. */
export const HEALTH_CHECK_TIMEOUT_MS = 2 * MS.SECOND;

/** Token last-used timestamps are flushed this often. */
export const LAST_USED_FLUSH_MS = 5 * MS.SECOND;
/** Signing and state keys are re-read this often. */
export const KEY_REFRESH_MS = 5 * MS.MINUTE;

export const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/** Fingerprinted assets never change: cache them for a year. */
export const IMMUTABLE_MAX_AGE_SECONDS = 365 * SECONDS.DAY;
export const IMMUTABLE_CACHE_CONTROL = `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`;
/** Self-hosted fonts are fingerprinted by name only: a week. */
export const FONT_CACHE_CONTROL = `public, max-age=${SECONDS.WEEK}`;

/** Longest step detail stored for a TEST run, and longest error code kept from an upstream failure. */
export const MAX_STEP_DETAIL_CHARS = 8_000;
export const MAX_ERROR_CODE_CHARS = 120;
