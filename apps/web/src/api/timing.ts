/**
 * How long answers stay fresh and how often the console asks again. Named once so that "how stale may this be" is a
 * decision in one place, not a number in a hook.
 */
import { MINUTE, SECOND } from '@/lib/time';

/** Default freshness of any query (`QueryClient` default). */
export const STALE_DEFAULT_MS = 15 * SECOND;
/** Lookups that rarely change while a screen is open: names, tool counts. */
export const STALE_LOOKUP_MS = MINUTE;
/** The session (`/me`) and the command palette's lists. */
export const STALE_LONG_MS = 5 * MINUTE;

/** System status refreshes this often while the screen is open. */
export const POLL_SYSTEM_MS = 30 * SECOND;
/** A version whose automatic test is running is re-read this often. */
export const POLL_TEST_RUN_MS = 800;
/** A registry source is re-read this often while a sync the user asked for has not reported back. */
export const POLL_REGISTRY_SYNC_MS = 2 * SECOND;

/** A requested registry sync that reports nothing for this long counts as lost. */
export const REGISTRY_SYNC_TIMEOUT_MS = 15 * MINUTE;
/** The stats of a finished walk are written after the click; allowance for clock skew between server and browser. */
export const REGISTRY_SYNC_SKEW_MS = 5 * SECOND;
