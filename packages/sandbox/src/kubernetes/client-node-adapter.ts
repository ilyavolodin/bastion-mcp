import {
  CoreV1Api,
  CustomObjectsApi,
  type KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  Watch,
} from '@kubernetes/client-node';
import { CLAIM_API, type KubeObject, kubeObjectSchema, SANDBOX_API } from './crd';
import { type KubeApi, KubeApiError, type KubeKind } from './kube-api';

/** Narrow views of the client-node APIs this adapter calls, so tests can fake them. */
export interface CustomApiLike {
  getNamespacedCustomObject(p: CustomRef & { name: string }): Promise<unknown>;
  createNamespacedCustomObject(p: CustomRef & { body: object }): Promise<unknown>;
  patchNamespacedCustomObject(
    p: CustomRef & { name: string; body: object },
    o?: unknown,
  ): Promise<unknown>;
  deleteNamespacedCustomObject(p: CustomRef & { name: string }): Promise<unknown>;
  listNamespacedCustomObject(p: CustomRef & { labelSelector?: string }): Promise<unknown>;
}
type CustomRef = { group: string; version: string; namespace: string; plural: string };

export interface CoreApiLike {
  readNamespacedPersistentVolumeClaim(p: { name: string; namespace: string }): Promise<unknown>;
  deleteNamespacedPersistentVolumeClaim(p: { name: string; namespace: string }): Promise<unknown>;
  listNamespacedPersistentVolumeClaim(p: {
    namespace: string;
    labelSelector?: string;
  }): Promise<unknown>;
  deleteCollectionNamespacedPersistentVolumeClaim(p: {
    namespace: string;
    labelSelector?: string;
  }): Promise<unknown>;
}

export interface WatcherLike {
  watch(
    path: string,
    query: Record<string, string>,
    callback: (phase: string, obj: unknown) => void,
    done: (err: unknown) => void,
  ): Promise<{ abort(): void }>;
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
    ? error.code
    : undefined;

const toApiError = (error: unknown): unknown => {
  const status = statusOf(error);
  return status === undefined
    ? error
    : new KubeApiError(status, error instanceof Error ? error.message : String(error));
};

const parseObject = (value: unknown): KubeObject => kubeObjectSchema.parse(value) as KubeObject;

const parseList = (value: unknown): KubeObject[] => {
  const items =
    typeof value === 'object' && value !== null && 'items' in value && Array.isArray(value.items)
      ? (value.items as unknown[])
      : [];
  return items.map(parseObject);
};

const ref = (kind: 'claim' | 'sandbox', namespace: string): CustomRef => ({
  ...(kind === 'claim' ? CLAIM_API : SANDBOX_API),
  namespace,
});

/** `KubeApi` over `@kubernetes/client-node` 2.0.0, scoped to one namespace. */
export const createKubeApi = (deps: {
  namespace: string;
  custom: CustomApiLike;
  core: CoreApiLike;
  watcher: WatcherLike;
}): KubeApi => {
  const { namespace, custom, core, watcher } = deps;
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw toApiError(error);
    }
  };
  const missingOk = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (statusOf(error) !== 404) throw toApiError(error);
    }
  };

  return {
    async get(kind: KubeKind, name) {
      try {
        const raw =
          kind === 'pvc'
            ? await core.readNamespacedPersistentVolumeClaim({ name, namespace })
            : await custom.getNamespacedCustomObject({ ...ref(kind, namespace), name });
        return parseObject(raw);
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw toApiError(error);
      }
    },
    async create(_kind, body) {
      return parseObject(
        await guard(() =>
          custom.createNamespacedCustomObject({ ...ref('claim', namespace), body }),
        ),
      );
    },
    async patch(kind, name, body) {
      await guard(() =>
        custom.patchNamespacedCustomObject(
          { ...ref(kind, namespace), name, body },
          setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
        ),
      );
    },
    async delete(kind, name) {
      await missingOk(() =>
        kind === 'pvc'
          ? core.deleteNamespacedPersistentVolumeClaim({ name, namespace })
          : custom.deleteNamespacedCustomObject({ ...ref(kind, namespace), name }),
      );
    },
    async list(kind, labelSelector) {
      const raw = await guard(() =>
        kind === 'pvc'
          ? core.listNamespacedPersistentVolumeClaim({ namespace, labelSelector })
          : custom.listNamespacedCustomObject({ ...ref(kind, namespace), labelSelector }),
      );
      return parseList(raw);
    },
    async deleteMatching(_kind, labelSelector) {
      await guard(() =>
        core.deleteCollectionNamespacedPersistentVolumeClaim({ namespace, labelSelector }),
      );
    },
    async *watchClaim(name, signal) {
      const current = await this.get('claim', name, signal);
      if (current) yield current;
      const queue: KubeObject[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      const notify = (): void => {
        wake?.();
        wake = undefined;
      };
      const path = `/apis/${CLAIM_API.group}/${CLAIM_API.version}/namespaces/${namespace}/${CLAIM_API.plural}`;
      const controller = await watcher.watch(
        path,
        { fieldSelector: `metadata.name=${name}` },
        (phase, obj) => {
          if (phase === 'DELETED') return;
          const parsed = kubeObjectSchema.safeParse(obj);
          if (parsed.success) {
            queue.push(parsed.data as KubeObject);
            notify();
          }
        },
        () => {
          finished = true;
          notify();
        },
      );
      signal.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        while (!signal.aborted) {
          const next = queue.shift();
          if (next) yield next;
          else if (finished) return;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
        }
      } finally {
        controller.abort();
      }
    },
  };
};

/** Production wiring: `KubeConfig.loadFromCluster()` inside the worker pod. */
export const createClientNodeKubeApi = (kc: KubeConfig, namespace: string): KubeApi =>
  createKubeApi({
    namespace,
    custom: kc.makeApiClient(CustomObjectsApi) as unknown as CustomApiLike,
    core: kc.makeApiClient(CoreV1Api) as unknown as CoreApiLike,
    watcher: new Watch(kc) as unknown as WatcherLike,
  });
