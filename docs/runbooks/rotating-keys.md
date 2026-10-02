# Runbook: rotating keys

Bastion has three signing or encryption keyrings stored as `system` secrets, a KMS key (the KEK) that wraps every data
key, and an internal secret that signs worker-to-worker requests (22.3). This runbook covers routine and emergency
rotation of each.

| Key | What it protects | Routine schedule | Command |
| --- | --- | --- | --- |
| `as` | ES256 signing keys for access tokens | every 30 days (automatic); old keys verify for 7 more days | `bastion rotate-keys --purpose as` |
| `upstream-client` | ES256 keys for `private_key_jwt` at upstream authorization servers, published at `/oauth/upstream/jwks` | every 90 days | `bastion rotate-keys --purpose upstream-client` |
| `state` | AES-256-GCM keys for `requestState`, task IDs, cursors, OAuth `state` | **daily** (automatic); the previous two days still decrypt | `bastion rotate-keys --purpose state` |
| KEK | Wraps all per-secret data keys | per your key policy | `POST /api/v1/system/kms/rotate` (Admin) |
| Internal secret | HMAC of internal RPC | per your policy | two-phase procedure below |

Run CLI commands against the cluster: `kubectl -n bastion exec deploy/bastion-ui -- bastion rotate-keys --purpose <p>`.
Take a Postgres backup first for emergency rotations. The keyring rows are in Postgres, envelope-encrypted.

## `as` (access token signing)

1. `bastion rotate-keys --purpose as`. A new key signs new tokens; **old keys keep verifying for 7 days**, so tokens
   issued before the rotation (15 minute lifetime) keep working. Workers load the keys at start and on `bastion:config`
   key events, so no restart is needed.
2. **Emergency (suspected key compromise):** rotation alone leaves the old key verifying for 7 days (design 9.3). The
   design does not describe an early-retirement command; to cut tokens signed with the leaked key off sooner,
   revoke the affected principals' tokens (revocation sets `revoked:{principalId}` in Redis and tokens with an earlier
   `iat` are rejected, 9.3), or remove the old key row with your administrator's database procedure after a backup.
   Users and clients re-authenticate. Refresh tokens are opaque and unaffected by signing key rotation; revoke them
   too if they may have leaked.
3. Verify: sign in with a client; decode a fresh access token (`kid` is the new key); a token from before the rotation
   still works (routine) or is rejected (emergency).

## `state`

`bastion rotate-keys --purpose state`. A key ID prefixes every token; the previous two days still decrypt, so open
continuations, cursors, tasks and OAuth flows survive one forced rotation. **Rotating twice within a day invalidates
state older than the oldest accepted key**: in-flight OAuth connects and paginated cursors fail and clients start over.
After a compromise, rotate three times (or wait three days) to retire the leaked key from the accepted set, and expect
interrupted flows.

## `upstream-client`

`bastion rotate-keys --purpose upstream-client`. Upstream authorization servers fetch `/oauth/upstream/jwks` (the CIMD
document points at it), so they pick up the new key; confirm that a Connect flow and a token refresh against each
upstream that uses `private_key_jwt` still work. Upstreams that cache JWKS for a long time may reject the first requests
signed by the new key: test the important ones right after rotating.

## KEK

1. Create a new key version (or new key) in your KMS and grant the Bastion identity access to it (admin guide, section 6).
   Keep the old version enabled.
2. Call `POST /api/v1/system/kms/rotate` as an Admin. A background job re-wraps data keys under the new KEK **without
   touching ciphertexts**.
3. Watch System status for the job; when it is complete, you can disable the old key version. Do not delete it until a
   Postgres backup taken after the re-wrap exists: older backups still need the old version.
4. Local KMS: create the new key file, mount both during the job, then remove the old one after the job and a fresh
   backup. Keep every key file that any backup depends on.

## Internal secret (`BASTION_INTERNAL_SECRET`)

The secret signs `X-Bastion-Sig` on internal RPC; the receiver accepts `BASTION_INTERNAL_SECRET` and
`BASTION_INTERNAL_SECRET_PREVIOUS`. During a rolling restart old and new pods coexist, so use **two rollouts** (the Helm
chart reads both from your Secret):

1. Let the current value be **A** and the new one **B**. Update the Secret to `INTERNAL_SECRET=A`,
   `INTERNAL_SECRET_PREVIOUS=B`, and roll the worker and ui Deployments (`kubectl rollout restart`). Every pod now
   accepts both; they still sign with A.
2. Update the Secret to `INTERNAL_SECRET=B`, `INTERNAL_SECRET_PREVIOUS=A`; roll again. Pods sign with B; during the roll
   old pods still accept B (from step 1).
3. When the rollout is complete and for at least a few minutes after (signed requests are valid within 30 s of the
   timestamp), remove `INTERNAL_SECRET_PREVIOUS` and roll once more.

A single-step rotation (`INTERNAL_SECRET=B`, `INTERNAL_SECRET_PREVIOUS=A`, one rollout) works, but during the roll new pods
sign with B while not-yet-restarted pods only know A, so forwarded calls from new to old pods fail until the roll finishes
(clients retry). Use it only in a quiet window or an emergency. The secret must be at least 32 bytes
(`openssl rand -base64 48`).

## After any rotation

- Record it in your change log (and check the audit log for the rotation event; the design says management changes and
  security events are audited).
- Check error rates for `401`s and `-32014` for 15 minutes.
- Update your runbook date for the next scheduled rotation.
