import type { KubeObject } from './crd';

/**
 * The only cluster surface the Kubernetes driver uses (ports and adapters). Unit tests inject a fake;
 * `client-node-adapter.ts` implements it with `@kubernetes/client-node`. All calls are scoped to the
 * sandbox namespace (`BASTION_SANDBOX_NAMESPACE`).
 */
export type KubeKind = 'claim' | 'sandbox' | 'pvc';

export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'KubeApiError';
  }
}

export interface KubeApi {
  /** Returns null when the object does not exist. */
  get(kind: KubeKind, name: string, signal?: AbortSignal): Promise<KubeObject | null>;
  /** Throws `KubeApiError(409)` when the name exists. */
  create(kind: 'claim', body: KubeObject, signal?: AbortSignal): Promise<KubeObject>;
  /** JSON merge patch. */
  patch(
    kind: 'claim' | 'sandbox',
    name: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Idempotent: a missing object is not an error. */
  delete(kind: KubeKind, name: string, signal?: AbortSignal): Promise<void>;
  list(kind: KubeKind, labelSelector: string, signal?: AbortSignal): Promise<KubeObject[]>;
  /** Deletes every object matching the selector (used for the PVCs of a deleted installation). */
  deleteMatching(kind: 'pvc', labelSelector: string, signal?: AbortSignal): Promise<void>;
  /** Yields the claim's current state, then every change, until aborted or the stream ends. */
  watchClaim(name: string, signal: AbortSignal): AsyncIterable<KubeObject>;
}
