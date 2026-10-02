import type { TaskFn } from '../types';

/**
 * 15.5: minute, hour and day rollups of `call_log`, every minute. Each job recomputes from a few buckets back and
 * is idempotent, so a repeated or concurrent run is harmless.
 */
export const rollups: TaskFn = async ({ infra, now }) => {
  const at = now();
  const minute = await infra.repos.callLog.rollupMinuteJob(at);
  const hour = await infra.repos.callLog.rollupHourJob(at);
  const day = await infra.repos.callLog.rollupDayJob(at);
  return { minute: minute.buckets, hour: hour.buckets, day: day.buckets };
};
