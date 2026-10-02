/** Open-loop pacing: requests are started on a fixed schedule regardless of how fast earlier ones finish. */

export type PaceOptions = {
  rate: number;
  durationSec: number;
  /** Requests above this many in flight are not started (counted as `skipped`, which lowers the achieved rate). */
  maxInflight: number;
  /** Runs one request; resolves with its latency in ms, rejects on failure. */
  fire: (index: number) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type PaceResult = {
  latenciesMs: number[];
  errors: number;
  skipped: number;
  started: number;
  wallSec: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Number of requests that should have started `elapsedMs` after the beginning of a run at `rate` per second. */
export const dueCount = (rate: number, elapsedMs: number): number =>
  Math.floor((rate * elapsedMs) / 1000);

export const pace = async (opts: PaceOptions): Promise<PaceResult> => {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;
  const total = Math.floor(opts.rate * opts.durationSec);
  const latenciesMs: number[] = [];
  let errors = 0;
  let skipped = 0;
  let started = 0;
  let inflight = 0;
  const pending = new Set<Promise<void>>();
  const begin = now();

  while (started + skipped < total) {
    const due = Math.min(total, dueCount(opts.rate, now() - begin));
    while (started + skipped < due) {
      const index = started + skipped;
      if (inflight >= opts.maxInflight) {
        skipped += 1;
        continue;
      }
      started += 1;
      inflight += 1;
      const task = opts
        .fire(index)
        .then((ms) => {
          latenciesMs.push(ms);
        })
        .catch(() => {
          errors += 1;
        })
        .finally(() => {
          inflight -= 1;
          pending.delete(task);
        });
      pending.add(task);
    }
    if (started + skipped >= total) break;
    await sleep(1);
  }
  await Promise.all(pending);
  return { latenciesMs, errors, skipped, started, wallSec: (now() - begin) / 1000 };
};
