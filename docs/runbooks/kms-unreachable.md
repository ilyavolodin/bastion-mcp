# Runbook: KMS unreachable

## Symptoms

- Errors mentioning the KMS provider (permission denied, timeout, key disabled) in worker or ui logs.
- **Settings, System status** shows the KMS check failing. Saving secrets fails; new upstream credentials cannot be read.
- Calls to installations that need a credential not yet cached start failing (`-32015` or `-32014`).

## Impact (21.3)

Each secret is encrypted with its own data key, wrapped by the KMS key. Unwrapped data keys are cached in memory for
**15 minutes** (LRU, 1,000 keys). So:

- Running work continues for up to 15 minutes for credentials whose keys are cached.
- New secrets cannot be written; secrets whose data key is not cached cannot be read: first calls after a worker
  restart, rarely used installations, token refresh for uncached rows.
- Restarting a worker empties its cache: **do not restart workers** during the outage unless you must.
- Signing keyrings (`as`, `state`, `upstream-client`) are stored as secrets and are affected the same way when their
  cached keys age out.

## Diagnose

```sh
kubectl -n bastion logs deploy/bastion-worker --tail=200 | grep -i kms
kubectl -n bastion get sa bastion -o yaml            # workload identity annotation present?
kubectl -n bastion get deploy bastion-worker -o jsonpath='{.spec.template.spec.containers[0].env}' | tr ',' '\n' | grep -E 'KMS'
```

By provider:

- **gcp**: key state (enabled, not scheduled for destruction); IAM binding of the Google service account;
  `iam.gke.io/gcp-service-account` annotation; the Kubernetes service account's `roles/iam.workloadIdentityUser` binding.
- **aws**: key state (`Enabled`), key policy and IAM role grants for `kms:Encrypt`, `kms:Decrypt`, `kms:DescribeKey`;
  IRSA annotation and OIDC trust; regional endpoint reachability.
- **azure**: Key Vault firewall and private endpoint, Crypto User role assignment, federated credential for the pod
  identity, key enabled and not expired.
- **vault**: seal status (`vault status`), token TTL or auth method, the `transit/encrypt` and `transit/decrypt` policy,
  `VAULT_ADDR` reachability from the cluster.
- **local**: the key file is missing or unreadable (secret mounted at `/keys/kek`; uid 10001 must read it), or the file
  differs from the one that wrapped the data keys.

## Act

1. Fix access (IAM, network, unseal Vault, re-enable the key). Workers retry on their own.
2. If the key was **disabled or scheduled for deletion**, re-enable it immediately: **destroying the KMS key makes
   every encrypted secret permanently unreadable.** Restore from the provider's key-version retention if it was destroyed.
3. If the local key file was lost, restore it from your backup (admin guide, section 12). There is no recovery without
   the original key.
4. If the outage will outlast the 15 minute cache, expect failing credentials; communicate which installations are
   affected (those with `userSecret`, `orgSecret` or upstream OAuth tokens).

## Verify

- KMS check green in System status; save a test org secret; a call that uses an uncached credential succeeds.
- No new KMS errors in logs for 10 minutes.

## Afterwards

If you are changing the KMS key or provider on purpose, use KEK rotation (`POST /api/v1/system/kms/rotate`), which
re-wraps data keys in a background job ([rotating-keys](rotating-keys.md)); never swap `BASTION_KMS_KEY` to a different
key by hand without re-wrapping.
