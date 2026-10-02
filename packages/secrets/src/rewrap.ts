import type { KmsProvider, SecretRepository } from './types';

export type RewrapResult = { rewrapped: number; failed: string[]; lastId: string | undefined };

/**
 * 22.3 KEK rotation: re-wraps one batch of DEKs that are not under the current `kek_ref`.
 * Ciphertexts, IVs and tags are never read or written. A row that fails is reported, not fatal.
 */
export const rewrapBatch = async (
  repo: SecretRepository,
  kms: KmsProvider,
  options: { batchSize?: number; afterId?: string; signal?: AbortSignal } = {},
): Promise<RewrapResult> => {
  const rows = await repo.listWrappedDeksNotUnder(
    kms.kekRef,
    options.batchSize ?? 100,
    options.afterId,
  );
  let rewrapped = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const dek = await kms.unwrap(row.wrappedDek, row.kekRef, options.signal);
      try {
        await repo.updateWrappedDek(row.id, await kms.wrap(dek, options.signal), kms.kekRef);
        rewrapped += 1;
      } finally {
        dek.fill(0);
      }
    } catch {
      failed.push(row.id);
    }
  }
  return { rewrapped, failed, lastId: rows.at(-1)?.id };
};

/** Runs batches until no rows remain under an old KEK. Failed rows are skipped and returned. */
export const rewrapAll = async (
  repo: SecretRepository,
  kms: KmsProvider,
  options: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<{ rewrapped: number; failed: string[] }> => {
  const batchSize = options.batchSize ?? 100;
  let rewrapped = 0;
  const failed: string[] = [];
  let afterId: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await rewrapBatch(repo, kms, {
      batchSize,
      ...(afterId === undefined ? {} : { afterId }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    rewrapped += result.rewrapped;
    failed.push(...result.failed);
    if (result.lastId === undefined) break;
    afterId = result.lastId;
  }
  return { rewrapped, failed };
};
