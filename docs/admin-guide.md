# Bastion administrator guide

This guide covers installing, configuring, operating and upgrading Bastion. Section numbers in parentheses refer to
the technical design, [`tdd.md`](tdd.md). Day-to-day failures are in [`runbooks/`](runbooks/README.md); the security
model is in [`security.md`](security.md); user-facing instructions are in [`user-guide.md`](user-guide.md).

## 0. What exists today and what has been verified

Read this first: the deployment assets and this guide were written while parts of the product were still being built.

| Piece | State when this guide was written |
| --- | --- |
| `apps/server` (the process behind every command below), `apps/web`, `packages/api`, `mcp-downstream` | Not in the repository yet (`docs/STATUS.md`). The `bastion` CLI, `/healthz`, `/readyz` and the routes described here are the specified behavior (`tdd.md`), not code you can run today. |
| Container image `Dockerfile` | Parses cleanly (`docker build --check`) and lints (hadolint). It has **not been built**, because `apps/server` does not exist; the build contract it assumes is written in its header comment. |
| `Dockerfile.sandbox`, `apps/runner`, `packages/sandbox` | Exist (M3, in progress). |
| Helm chart `deploy/helm/bastion` | Validated: `helm lint`, `helm template` and `kubeconform -strict` for five values scenarios, including the agent-sandbox v1.0.2 CRDs, plus structural assertions (`deploy/helm/validate.sh`). **Never installed on a cluster.** |
| `compose.yaml` | Passes `docker compose config`. Never started (no server image). |
| `seccomp-bastion.json` | Derived from Docker's default profile; never exercised against a live `bwrap` (see 7.2). |
| Chaos, upgrade, load scripts and the kind setup | Written, shell-checked, **not run end to end**. The pure parts of the load harness (results checker, scenario config, pacing) have 34 unit tests. |
| GitHub release, nightly and weekly workflows | `actionlint` clean. Never triggered. The signing steps for macOS and Windows are placeholders gated on secrets. |
| Agent-sandbox behavior on a live cluster | Pending, see `docs/spikes/m3-agent-sandbox.md`. |

Where the design says Drizzle, the repository uses Prisma 7 (ADR 0001): `bastion migrate` applies Prisma migrations.

## 1. Requirements

- Kubernetes 1.29 or newer for the Helm install (the chart sets `kubeVersion: ">=1.29.0-0"`).
- PostgreSQL 16 or newer (17 is what the tests use). Connection string with `sslmode=verify-full` is recommended.
- Redis 7 or newer, or Valkey 8: standalone, Sentinel or Cluster, or a managed service. Use `rediss://` for TLS.
- For the Kubernetes sandbox driver: the **agent-sandbox controller with extensions, v1.0.2 or newer**
  (`kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.2/sandbox-with-extensions.yaml`),
  and a gVisor (`runsc`) or Kata `RuntimeClass` on at least one node pool. GKE Sandbox node pools work as they are.
- An ingress controller (ingress-nginx is what the chart's annotations target) or a Gateway API implementation, and a
  TLS certificate for the public hostname.
- An OIDC identity provider for people to sign in (section 5). Without one, only the break-glass local admin exists.
- A KMS for production (section 6). `local` keeps the key in a file and is for evaluation or single-host installs.

## 2. Install with Helm

1. Create the Secret the chart reads (it never creates one):

   ```sh
   kubectl create namespace bastion
   kubectl -n bastion create secret generic bastion-secrets \
     --from-literal=DATABASE_URL='postgres://bastion:...@pg.example.com:5432/bastion?sslmode=verify-full' \
     --from-literal=REDIS_URL='rediss://:...@redis.example.com:6379' \
     --from-literal=INTERNAL_SECRET="$(openssl rand -base64 48)"
   ```

   `INTERNAL_SECRET` must be at least 32 bytes. Optional keys: `INTERNAL_SECRET_PREVIOUS` (rotation),
   `DATABASE_REPLICA_URL` (read replica for dashboards, 21.1), and any KMS credential keys you list in
   `kms.credentialKeys`.

2. Install the agent-sandbox controller and make sure the RuntimeClass exists (`kubectl get runtimeclass gvisor`).

3. Install the chart (the chart is also published as an OCI artifact, `oci://ghcr.io/bastion-mcp/charts/bastion`):

   ```sh
   helm install bastion oci://ghcr.io/bastion-mcp/charts/bastion --version <version> -n bastion \
     --set publicUrl=https://mcp.example.com \
     --set existingSecret=bastion-secrets \
     --set kms.provider=gcp --set kms.key=projects/p/locations/global/keyRings/r/cryptoKeys/k \
     --set serviceAccount.annotations."iam\.gke\.io/gcp-service-account"=bastion@p.iam.gserviceaccount.com \
     --set ingress.className=nginx --set 'ingress.tls[0].secretName=bastion-tls' \
     --set bootstrapAdminEmail=you@example.com
   ```

   The pre-install Job runs `bastion migrate`. `NOTES.txt` prints the prerequisites it cannot check at render time.

4. Check it: `kubectl -n bastion rollout status deploy/bastion-worker deploy/bastion-ui`, then
   `curl https://mcp.example.com/readyz` (per-check JSON, 15.7).

5. Create the first admin if you did not set `bootstrapAdminEmail`:
   `kubectl -n bastion exec deploy/bastion-ui -- bastion create-admin --email you@example.com`. Then sign in, add an IdP
   connection (section 5), and set `localLogin: false` (the default) so password login stops once SSO works (9.1).

**Split versus all-in-one.** `deploymentMode: split` (default) renders `bastion-worker` (`BASTION_ROLE=worker`) and
`bastion-ui` (`BASTION_ROLE=ui`). `deploymentMode: all` renders one `bastion-all` Deployment (`BASTION_ROLE=all`),
serving every path on 8080; the chart then routes all paths to it and labels its pods `component: all`.

### 2.1 Helm values reference

Every key of `deploy/helm/bastion/values.yaml`, with its default. `values.schema.json` rejects wrong types and
unknown enum values; `publicUrl` and `existingSecret` are required.

| Key | Default | Meaning |
| --- | --- | --- |
| `publicUrl` | required | `BASTION_PUBLIC_URL`; an origin without a path. |
| `deploymentMode` | `split` | `split` or `all`. |
| `image.repository` / `image.tag` / `image.digest` / `image.pullPolicy` | `ghcr.io/bastion-mcp/bastion` / chart `appVersion` / `""` / `IfNotPresent` | `digest` (`sha256:...`) overrides `tag`. |
| `imagePullSecrets` | `[]` | |
| `existingSecret` | required | Secret with `DATABASE_URL`, `REDIS_URL`, `INTERNAL_SECRET` (+ optional keys above). |
| `worker.replicas` | `3` | Ignored while autoscaling is enabled. |
| `worker.autoscaling.enabled` / `minReplicas` / `maxReplicas` / `targetCPUUtilizationPercentage` | `true` / `3` / `20` / `70` | HPA (21.1). |
| `worker.resources` | request 1 CPU, 2 GiB; limit 4 CPU, 8 GiB | |
| `worker.ports.http` / `internal` / `egress` | `8080` / `7443` / `3128` | Public, worker-to-worker RPC, sandbox egress proxy. |
| `worker.nodeSelector` / `tolerations` / `affinity` / `podAnnotations` / `podLabels` | empty | |
| `ui.replicas` | `2` | |
| `ui.resources` | request 0.5 CPU, 1 GiB; limit 2 CPU, 2 GiB | |
| `ui.gitCache.mountPath` / `sizeLimit` | `/var/cache/bastion/git` / `10Gi` | `emptyDir` for the plugin git channel; sets `BASTION_GIT_CACHE_DIR` (25.5). |
| `ui.nodeSelector` / `tolerations` / `affinity` / `podAnnotations` / `podLabels` | empty | |
| `all.replicas`, `all.resources`, `all.gitCache.*`, `all.nodeSelector`, ... | 1; as worker; as ui; empty | Only for `deploymentMode: all`. |
| `terminationGracePeriodSeconds` | `30` | Worker drain is up to 25 s inside it (21.2). Schema minimum is 30. |
| `podDisruptionBudget.enabled` / `minAvailable` | `true` / `1` | One PDB per role; an `all` Deployment gets one only with more than one replica. |
| `topologySpreadConstraints` | zone and node, `maxSkew: 1`, `ScheduleAnyway` | The chart adds the per-role `labelSelector`. Use `DoNotSchedule` on large clusters. |
| `podSecurityContext` | non-root uid 10001, `fsGroup` 10001, `RuntimeDefault` seccomp | |
| `containerSecurityContext` | no privilege escalation, read-only root filesystem, drop `ALL` | `/tmp` and `/var/lib/bastion` are `emptyDir`s. |
| `serviceAccount.create` / `name` / `annotations` | `true` / `""` / `{}` | One ServiceAccount shared by worker and ui; annotations carry workload identity for the KMS. |
| `kms.provider` | `local` | `local`, `gcp`, `aws`, `azure`, `vault`. |
| `kms.key` | `/keys/kek` | Local: file path; GCP: key resource name; AWS: key ARN; Azure: key URL; Vault: `transit/keys/<name>`. |
| `kms.localKeySecret` / `kms.localKeySecretKey` | `""` / `kek` | Local provider: a Secret holding the 32-byte key, mounted read-only at `/keys`. |
| `kms.credentialKeys` | `[]` | Keys of `existingSecret` exported as env vars of the same name (for example `VAULT_TOKEN`). |
| `bootstrapAdminEmail` | `""` | `BASTION_BOOTSTRAP_ADMIN_EMAIL`. |
| `localLogin` | `false` | `BASTION_LOCAL_LOGIN`. |
| `logLevel` | `info` | `BASTION_LOG_LEVEL`. |
| `clusterCIDRs` | `[]` | `BASTION_CLUSTER_CIDRS`: pod and service CIDRs the egress proxy always denies. **Set this.** |
| `env` / `extraEnv` | `{}` / `[]` | Any other `BASTION_*` variable (19.1), as a map or as raw `EnvVar` entries. |
| `ingress.enabled` / `className` / `host` / `annotations` / `tls` | `true` / `nginx` / host of `publicUrl` / `{}` / `[]` | Ignored when `httpRoute.enabled`. |
| `ingress.streamingAnnotations` | `proxy-read-timeout: "3600"`, `proxy-send-timeout: "3600"`, `proxy-buffering: "off"` | ingress-nginx; merged under `annotations` (20.2). |
| `httpRoute.enabled` / `parentRefs` / `hostnames` / `mcpRequestTimeout` | `false` / `[]` / host of `publicUrl` / `0s` | Gateway API route with `timeouts.request: 0s` on the MCP rule. |
| `gke.backendConfig.enabled` / `timeoutSec` | `false` / `3600` | Creates a `BackendConfig` and annotates the worker Service. |
| `sandbox.enabled` | `true` | Namespace, SandboxTemplates, SandboxWarmPools, Role and RoleBinding. |
| `sandbox.namespace` | `bastion-sandboxes` | `BASTION_SANDBOX_NAMESPACE`. |
| `sandbox.driver` | `""` | Empty means `kubernetes` when sandboxes are enabled, `bubblewrap` otherwise. |
| `sandbox.runtimeClassName` | `gvisor` | `kata-qemu` for Kata. |
| `sandbox.image.repository` / `tag` / `digest` | `ghcr.io/bastion-mcp/sandbox-runtime` / appVersion / `""` | `BASTION_SANDBOX_IMAGE`. |
| `sandbox.warmPool.small` / `medium` / `large` | `5` / `2` / `0` | Plus `-pvc` pools at 0 for persistent workspaces. |
| `sandbox.sizes.<size>.requests/limits` | small 0.25 to 1 CPU, 512 MiB; medium 0.5 to 2 CPU, 1 GiB; large 1 to 4 CPU, 4 GiB | |
| `sandbox.volumes.tmpSizeLimit` / `mcpSizeLimit` / `homeSizeLimit` / `workspaceSizeLimit` | `256Mi` / `2Gi` / `256Mi` / `2Gi` | `emptyDir` limits (8.4 fixes `/tmp` and `/opt/mcp`; home and workspace limits are this chart's choice). |
| `sandbox.namespaceLabels` | `pod-security.kubernetes.io/enforce: restricted` | |
| `sandbox.keepNamespace` | `true` | Annotates the namespace `helm.sh/resource-policy: keep`. |
| `networkPolicies.enabled` | `true` | Workers accept 8080 from the ingress controller, 7443 from workers, 3128 from the sandbox namespace; ui accepts 8080 from the ingress controller. |
| `networkPolicies.ingressController.namespaceSelector` / `podSelector` | `kubernetes.io/metadata.name: ingress-nginx` / `{}` | Match your controller. |
| `networkPolicies.extraIngress.worker` / `ui` | `[]` | Extra ingress rules, for example Prometheus scraping. |
| `migrations.enabled` / `backoffLimit` / `activeDeadlineSeconds` | `true` / `2` / `600` | `pre-install,pre-upgrade` Job running `bastion migrate`. |
| `otelCollector.enabled` | `false` | Optional collector with tail sampling. |
| `otelCollector.image.*` / `replicas` / `resources` | `otel/opentelemetry-collector-contrib:0.161.0` / `1` / small | Keep one replica: tail sampling needs a trace's spans on one instance. |
| `otelCollector.tailSampling.decisionWait` / `numTraces` / `baselinePercentage` | `10s` / `50000` / `10` | Keeps every trace with an ERROR span plus a baseline percentage of the rest (15.1). |
| `otelCollector.exporter.endpoint` / `headers` | `""` / `{}` | OTLP/HTTP backend. Empty exports to the collector's `debug` exporter. |

Two behaviors worth knowing:

- The worker Service is a plain ClusterIP Service on 8080, 7443 and 3128. Sandboxes receive its ClusterIP as the
  egress proxy address (their NetworkPolicy allows no DNS, 8.8), and the Service spreads their connections over the
  workers. Do not make it headless.
- The SandboxTemplate NetworkPolicy selects worker pods by `app.kubernetes.io/component: worker` in the release
  namespace (`all` in all-in-one mode). Do not relabel worker pods.

### 2.2 Routing, TLS and streaming

Paths `/mcp` and `/.well-known/oauth-protected-resource` go to the worker Service; `/plugins`, `/registry`, `/oauth`
and everything else go to the ui Service (4.2). `subscriptions/listen` and legacy `GET` streams are long-lived:
ingress-nginx gets one-hour read and send timeouts and buffering off; GKE gets the `BackendConfig`; Gateway API gets
`timeouts.request: 0s`. Bastion sends an SSE comment every 25 s on idle streams. Session affinity is not needed.
If you front the ingress with another proxy or a cloud load balancer, raise its idle timeout above one hour or expect
streams to be cut (clients reconnect).

Mirrored plugins make vendor-hosted clients (claude.ai, ChatGPT) call `https://<host>/mcp/c/...` from the vendor's
network, so `/mcp` must be reachable from the internet for those surfaces (25.5).

### 2.3 Gateway API

`ingress.enabled=false`, `httpRoute.enabled=true`, `httpRoute.parentRefs=[{name: gw, namespace: infra}]`. The chart
renders one `HTTPRoute` with two rules; it does not create the Gateway.

## 3. Install as a single container

```sh
docker run -d --name bastion \
  -e BASTION_ROLE=all -e BASTION_PUBLIC_URL=https://mcp.example.com \
  -e BASTION_DATABASE_URL=postgres://... -e BASTION_REDIS_URL=redis://... \
  -e BASTION_INTERNAL_SECRET=... -e BASTION_KMS=local -e BASTION_KMS_KEY=/keys/kek \
  -e BASTION_BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -v bastion-data:/var/lib/bastion -v /secure/kek:/keys/kek:ro \
  --security-opt seccomp=/path/to/seccomp-bastion.json \
  -p 8080:8080 ghcr.io/bastion-mcp/bastion:<version>
```

Create the 32-byte key once with `head -c 32 /dev/urandom > /secure/kek`, make it readable by uid 10001, and **back it
up**: without it the encrypted secrets in Postgres cannot be read.

For evaluation, `deploy/docker/compose.yaml` starts Bastion, `postgres:17` and `valkey/valkey:8`:

```sh
cd deploy/docker && cp .env.example .env   # fill in the placeholders
docker compose up -d
```

An `init-kek` service writes a random 32-byte key into the `bastion-keys` volume on first start (never overwritten),
`migrate` runs `bastion migrate`, then `bastion` starts with the seccomp profile applied through `security_opt`. Back
up the `bastion-keys` volume.

With `BASTION_ROLE=all` the process serves every route on 8080, runs the scheduler and the bubblewrap driver, and keeps
the internal RPC listener on, so replicas can be added later. Several `all` replicas work, but each owns only the
bubblewrap sandboxes it started; when it dies they die with it and restart elsewhere on the next use (20.3).

### 3.1 Remote MCP servers on your own network

By default Bastion only connects to hosts that are on the public internet and use HTTPS (8.9, 23.3). That covers remote
MCP servers, identity providers (the Test button on the Identity Provider page and the sign-in itself) and the sign-in
service of an OAuth server. A host on a home lab or office network, or one whose name resolves to a private address
such as `192.168.x.x` (an identity provider on a NAS, for example), is refused with the message *"sso.example.com
resolves to 192.168.1.2, a private network address ..."*. An administrator allows it with two settings, both read at
start (restart Bastion after changing them):

| Variable | Meaning |
| --- | --- |
| `BASTION_PRIVATE_UPSTREAM_CIDRS` | Comma-separated CIDRs that administrator-authored catalog entries, identity providers and OAuth sign-in services may reach, e.g. `192.168.1.2/32` or `192.168.1.0/24`. The cloud metadata address is never allowed, and personal installations never reach private networks. |
| `BASTION_INSECURE_UPSTREAM_HOSTS` | Hosts that may be reached over plain HTTP (no TLS), e.g. `automations.lan`. Only for networks you trust. |

With Docker Compose set them in `deploy/docker/.env`, then `docker compose up -d bastion`.

### 3.2 Remote MCP servers that sign each person in (OAuth)

Choose **OAuth** under Authentication in the catalog editor and each person connects their own account; Bastion keeps a
token per person and installation and never shares it. Two things to know:

- **Testing.** The Test step runs the server as you, so you connect your own account first. A failed test says so and
  shows **Connect your account**; after you sign in you return to the Test step and it runs again.
- **Client registration.** *Automatic* lets Bastion register itself with the service (client ID metadata document or
  dynamic registration). Some services, GitHub among them, only accept an app registered by hand. Choose *An app I
  registered*, register the OAuth app with the service using the callback URL the editor shows
  (`<public URL>/oauth/upstream/callback`), and enter its client ID and secret. The secret is stored encrypted as a
  shared secret (an Admin enters it) and is never shown again.

## 4. Images and supply chain

- `ghcr.io/bastion-mcp/bastion`: `node:24-bookworm-slim`, production dependencies only, the built SPA, `tini`,
  `bubblewrap`, `git`, `ca-certificates`, a bundled sandbox runtime at `/opt/runtime` (Node 24, `uv`, Python 3.13, git)
  and `/opt/bastion/runner.mjs`; uid 10001; `tini -- node --import ./dist/otel.js ./dist/main.js`; `HEALTHCHECK` on
  `/healthz`.
- `ghcr.io/bastion-mcp/sandbox-runtime`: the image the Kubernetes sandboxes run (uid 1000, read-only root).
- Both are `linux/amd64` and `linux/arm64`, signed keylessly with cosign from the release workflow, with an SPDX SBOM
  (syft) attached as a cosign attestation and as a release asset, and SLSA build provenance
  (BuildKit provenance plus GitHub's `attest-build-provenance`).

Verify before you deploy:

```sh
cosign verify ghcr.io/bastion-mcp/bastion@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/bastion-mcp/bastion-mcp/\.github/workflows/release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type spdxjson <same arguments> ghcr.io/bastion-mcp/bastion@sha256:<digest>
gh attestation verify oci://ghcr.io/bastion-mcp/bastion@sha256:<digest> --owner bastion-mcp
```

Pin `image.digest` in production. Release assets also contain `bastion-credential` binaries (macOS arm64 and x64,
Windows x64, Linux x64 and arm64) with `SHA256SUMS` and a cosign bundle. macOS notarization and Windows Authenticode
signing run only when their secrets are configured in the repository; until then those binaries are unsigned and the
release workflow says so with a warning.

## 5. Identity providers

Add connections under **Settings, Identity providers** (9.1). Each connection needs the OIDC discovery URL, client ID
and secret, scopes (`openid email profile`; add `offline_access` when `storeRefreshToken` is on), a claim mapping
(`email`, `name`, `groups`, `sub`), allowed email domains, and optionally an `apiScope`. With several connections the
login page routes by email domain. First login provisions the user (JIT); group mapping rules (teams and roles) run on
every login and every SCIM update. Copy the redirect URI the connection form shows into the IdP; it lives under
`https://<host>/auth/`.

**IdPs that accept only the site address as redirect URI.** Synology SSO Server refuses a redirect URI with a path
(`/auth/callback/<id>`): its application registration takes just `http(s)://host[:port]`. Turn on **Redirect to the
site address only** on the connection. Bastion then sends the bare site address (the Redirect URI the connection
shows is that address), the IdP returns to `/?code=...&state=...`, and Bastion completes the sign-in there. Only
a request to `/` that carries `code` or `error` together with `state` is treated as a callback, and only when the
sign-in state cookie of that connection (HttpOnly, ten minutes, single use) is present.

**Locked out after adding an IdP?** The local password login switches off as soon as one connection exists (even a
disabled one). Set `BASTION_LOCAL_LOGIN=true` (Docker Compose: in `deploy/docker/.env`, then `docker compose up -d
bastion`), sign in with the local admin, fix the connection, and turn it off again. If you forgot the local password:
`bastion reset-password --email <admin>`. Only request scopes the IdP lists in `scopes_supported` of its discovery
document: some IdPs (Synology SSO Server offers only `openid`, `email` and `groups`, and no refresh tokens) refuse
the sign-in when asked for others, such as `profile` or `offline_access`, with a generic error.

Turn on `storeRefreshToken` only if you use the `enterpriseManaged` or `tokenExchange` upstream credential modes
(9.7): Bastion then stores the user's IdP refresh token, envelope-encrypted.

| IdP | Setup notes (verify against your IdP's current console) |
| --- | --- |
| **Okta** | Create an OIDC web app. Discovery URL `https://<org>.okta.com/.well-known/openid-configuration` (or the custom authorization server's). Add a `groups` claim (Groups claim filter) to the ID token. SCIM: add a SCIM 2.0 app integration, base URL `https://<host>/scim/v2`, authentication HTTP header with the Bastion SCIM bearer token, unique identifier `userName`, enable create, update and deactivate and push groups. |
| **Microsoft Entra ID** | App registration (web). Discovery `https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration`. Emit group claims as group object IDs; users in more than 200 groups get a claim overage instead of the list, so prefer SCIM group provisioning (enterprise application, Provisioning, tenant URL `https://<host>/scim/v2`, secret token) or app roles. For `entra-obo` token exchange, expose an API (`api://<bastion-app>/user_impersonation`) and set it as the connection's `apiScope` (9.7). |
| **Google Workspace** | OAuth client (web) in Google Cloud. Discovery `https://accounts.google.com/.well-known/openid-configuration`. Google ID tokens carry no group membership: map roles by email domain or assign roles in Bastion; Google does not push SCIM to arbitrary SCIM servers, so provisioning is JIT only. |
| **Keycloak** | Client with "Client authentication" on and standard flow. Discovery `https://<kc>/realms/<realm>/.well-known/openid-configuration`. Add a "Group Membership" mapper (full path off) to the ID token as `groups`. Keycloak has no built-in SCIM server push; use JIT or a SCIM extension. |
| **Auth0** | Regular web application. Discovery `https://<tenant>.auth0.com/.well-known/openid-configuration`. Add groups or roles to the ID token with a post-login Action under a namespaced claim and map that claim name. SCIM is available only for enterprise connections that Auth0 provisions inbound; check your plan. |

**SCIM** (`/scim/v2`, `Users` and `Groups`, PATCH and filter support for Okta and Entra). Create the SCIM bearer token
in Settings. SCIM create provisions; `active: false` deactivates (revokes tokens and sessions, stops instances, deletes
upstream tokens, keeps call and audit rows); group membership becomes team membership.

**Group mapping.** Rules map IdP groups to teams (a team per group matching a regex, or explicit) and to roles (for
example `bastion-admins` to Admin). Roles: Admin, Manager (of a team), Member, Auditor (10.1).

**Break-glass.** `BASTION_BOOTSTRAP_ADMIN_EMAIL` creates a local admin on first start. Local password login stays
enabled only while no IdP connection exists or while `BASTION_LOCAL_LOGIN=true`; keep the credentials sealed.

### 5.1 Who is an administrator

There are two kinds of role. The **organization role** is one of **Admin**, **Auditor** and **Member**; **Manager** is a
role *within a team* (a Manager edits the team's membership and sees its traffic). A person who signs in through the
identity provider for the first time is created as a Member with no teams, unless a group mapping rule says otherwise.
To make an identity provider account an administrator, in this order of preference:

1. **Group mapping rule.** Map an IdP group (for example `bastion-admins`) to the Admin role under Access, IdP group
   mapping. The role is re-evaluated at every sign-in, so removing the person from the group removes the role.
2. **By hand.** An Admin opens Access, People and chooses the role in the list. If any mapping rule names a role, it
   also sets roles at every sign-in and replaces what was chosen by hand; the page says so. Without such rules a role
   chosen by hand stays.
3. **Command line**, for the case where nobody can sign in as an Admin (local password login is off once an identity
   provider exists): `bastion set-role --email <email> --role admin`. The account must exist, so the person signs in
   once first. The change is audited with the system as the actor.

To make somebody a team Manager, an Admin or a Manager of that team opens Access, Teams and chooses **Make manager**
next to the person. The last active Admin cannot be demoted or deactivated: make somebody else an Admin first.

## 6. KMS

Secrets are envelope-encrypted: a random data key per row (AES-256-GCM), wrapped by the KMS key. Choose with
`BASTION_KMS` and `BASTION_KMS_KEY` (`kms.provider`, `kms.key`):

| Provider | `kms.key` | Access to grant |
| --- | --- | --- |
| `local` | path to a 32-byte key file | none; protect and back up the file. Dev, evaluation, single host. |
| `gcp` | `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>` | the workload identity service account needs encrypt and decrypt on the key (`roles/cloudkms.cryptoKeyEncrypterDecrypter`). Annotate with `iam.gke.io/gcp-service-account`. |
| `aws` | key ARN | IRSA role (`eks.amazonaws.com/role-arn`) with `kms:Encrypt`, `kms:Decrypt`, `kms:DescribeKey` on the key. |
| `azure` | Key Vault key URL | Azure workload identity with wrap and unwrap permission (Key Vault Crypto User). Add `azure.workload.identity/use: "true"` to `podLabels` and the client ID annotation to the ServiceAccount. |
| `vault` | `transit/keys/<name>` | A token or auth method with `update` on `transit/encrypt/<name>` and `transit/decrypt/<name>`; pass the token through `kms.credentialKeys` (for example `VAULT_TOKEN`) and `VAULT_ADDR` through `env`. |

Unwrapped data keys are cached in memory for 15 minutes (1,000 keys), so a KMS outage does not stop running work
(runbook: [kms-unreachable](runbooks/kms-unreachable.md)). KEK rotation re-wraps data keys in a background job without
touching ciphertexts (`POST /api/v1/system/kms/rotate`, Admin; see [rotating keys](runbooks/rotating-keys.md)).

## 7. Sandboxes

### 7.1 Drivers and isolation levels

| Driver | Where | Isolation shown in the UI | Notes |
| --- | --- | --- | --- |
| `kubernetes` (default in the chart) | agent-sandbox pods in `bastion-sandboxes` | `gvisor` (RuntimeClass `gvisor`) or `kata` | Warm pools, per-claim runner token, no service account, read-only root, egress only through the worker proxy. |
| `bubblewrap` (default for `all`) | `bwrap` jails inside the Bastion container | `namespaces` | Needs unprivileged user namespaces; resource limits through cgroup v2 when writable, else `prlimit` plus RSS polling. |

Catalog entries can require `minIsolation: gvisor` or `kata`, which blocks them on the bubblewrap driver. Remote
installations need no sandbox. Org settings (`sandbox`): `defaultSize` (`small`), `warmPool` (5, 2, 0),
`idleTimeoutMinutes` (15). Caps: `BASTION_MAX_RUNNING_INSTANCES_PER_USER` (10) and `BASTION_MAX_RUNNING_SANDBOXES`
(500). Sandboxes only reach the network through the egress proxy and its per-entry allowlist; `BASTION_CLUSTER_CIDRS`,
loopback, link-local (including `169.254.169.254`), RFC 1918, CGNAT and IPv6 ULA are denied unless a CIDR entry
allows them (8.8). Package mirrors (`BASTION_NPM_REGISTRY`, `BASTION_PYPI_INDEX_URL`) are reachable during install only.

A server that talks to a host on your own network therefore needs two entries in its **Network** step: the host
(`docker.example.com:443`) and the address range it resolves to (`192.168.1.2/32`). `BASTION_PRIVATE_UPSTREAM_CIDRS`
does not apply to sandboxes. A refused connection answers `403 Blocked by Bastion: <host> resolves to <address>, a
private network address; add <address>/32 to this server's Network allowlist`, which is what the program in the
sandbox prints (for example `ProxyError: 403 Blocked by Bastion: ...`), and the denial is recorded in `egress_events`.

Warm-pool and claim details to know when operating: the driver names pools `bastion-runtime-<size>` and
`bastion-runtime-<size>-pvc`; claims are `bst-<12 hex of the id's random tail>` (ephemeral, 24 h shutdown time refreshed hourly) and
`bsp-<12 hex of the id's random tail>` (persistent workspaces, suspended on idle). The ui scheduler garbage-collects claims whose instance is
not in Postgres every 5 minutes. Several of these behaviors are still being confirmed on a live cluster
(`docs/spikes/m3-agent-sandbox.md`).

### 7.2 Bubblewrap prerequisites

- The container must be allowed to create user namespaces: run with `deploy/docker/seccomp-bastion.json`
  (`--security-opt seccomp=...`). **How the profile was derived:** it is the Docker/moby default profile
  (`moby/profiles`, `seccomp/default.json`, 60 syscall rules, copied unchanged) plus four appended rules: `clone` with
  `CLONE_NEWUSER` set in its flags (two rules, for the s390 argument order), `unshare` unrestricted, and `mount`,
  `umount`, `umount2`, `pivot_root`. The design specifies only the `clone`/`unshare` additions; the mount rules were
  added because `bwrap` builds its jail with `mount` and `pivot_root`, which the default profile denies without
  `CAP_SYS_ADMIN`. They only succeed inside the jail's own user namespace. **This profile has not been exercised against a
  live bwrap**; if you have a stricter policy, test `bwrap --unshare-user --unshare-net true` inside the container
  first. Bastion runs exactly that at startup and reports the driver `unavailable` with the error text if it fails
  (package installs are then disabled; remote installations keep working).
- On Ubuntu 24.04 hosts, AppArmor restricts unprivileged user namespaces: set
  `kernel.apparmor_restrict_unprivileged_userns=0` or install an AppArmor profile that allows `userns`.
- A second profile, `deploy/docker/sandbox-seccomp.json`, is the denylist applied to each jail (`ptrace`, `mount`,
  `keyctl`, `bpf`, `userfaultfd`, `perf_event_open`, `kexec_*`, namespace creation).

## 8. Registry sources and install policies

Registry sources (11.6) are servers implementing the MCP Registry API v0.1: the official registry (preconfigured,
**disabled until you enable it**), the GitHub MCP Registry, Azure API Center, or your own subregistry. Per source: name,
base URL, optional auth header secret, sync interval (1 hour), trust level (`official`, `internal`, `community`).
Sync is incremental (`updated_since`) with a weekly full re-sync; users browse mirrored data and never trigger live
registry searches.

Admins manage sources in **Settings -> Registry** (add a source, enable or disable it, Sync now, full re-sync, install
policy); the Registry screen links there. Enabling a source starts its first sync, which runs in the background (the
official registry holds tens of thousands of versions, so the first walk takes a few minutes); until it finishes the
Registry screen lists what is already mirrored. The browse list shows the newest version of each server of **enabled**
sources only, 24 per page, with the source name and trust level on every card.

Each source has one install policy (11.7):

| Setting | Default | Effect |
| --- | --- | --- |
| `allowedNamespaces` / `blockedNamespaces` | allow `*` / block none | Globs on server names, for example `io.github.acme/*`. They decide what members and managers **see** in the Registry as well as what may be installed: list only the names you want shown (default deny), or keep `*` and block a few (default allow). Admins and Auditors always see every server, with a *Hidden from members* mark on those the policy hides. |
| `allowedRuntimes` | `remote` | Add `npm` and `pypi` to allow sandboxed packages. Other registry types are shown as unsupported. |
| `whoMayInstall` | `managers` | `admins`, `managers` or `everyone`. |
| `mode` | `request` | `direct` (one click, then automatic test), `request` (approval by admins and the requester's managers), `catalogOnly`. |
| `requireOsvClean` | `true` | Reject lockfiles with `MAL-` advisories (needs `BASTION_OSV_CHECK=true`, the default). |
| `maxRisk` | `low` | Highest risk installable in `direct` mode. |

On the Registry screen an Admin can hide a server from members, or show it again, with one button on its card; it edits
these two lists of the source policy. A pattern in the blocked list that covers a name stays until it is changed in
Settings.

Bastion also serves a subregistry at `/registry/v0.1/servers` for MCP hosts with an enterprise registry setting (VS
Code, GitHub Copilot), authenticated with a PAT or OAuth token scoped `api:read` (11.8).

### 8.1 Hiding tools for everyone

On a server's Overrides tab each tool, prompt and resource has a switch; hiding is the common change, customizing a
definition is optional. An Admin or the owner of a catalog server can choose "Everyone who installs this server":
the change is then saved on the server's current version (`PUT /catalog/{id}/default-overrides`) and applies to every
installation on that version, before each person's own changes. Overrides never change what runs, so this does not
need a new version; older, pinned versions keep theirs.

The same tab adds prompts, resources and resource templates that Bastion itself serves ("Add prompt or resource"):
fixed messages or text, in which `{{name}}` is replaced by a prompt's arguments or a template's URI variables. They are
listed next to the upstream's, can be hidden like any other item, go through the same policy, limits and guards, and
are stored in the `added` section of the override document. In an installation's own overrides they need the entry's
`userOverrides` level `full`. They are not served while the upstream cannot be listed.

## 9. Guards

Guard profiles run on three phases (request, response, definition). The org default profile ships enabled:
`unicode` (redact), `size`, `regex` presets `secrets` (redact on responses, warn on requests) and
`injection-heuristics` (warn), and definition pinning with `hideChanged`. Deterministic guards run on every call and add
under 2 ms p99 for 64 KiB; model guards are opt-in. Actions, strongest first: `block`, `confirm`, `quarantine`,
`redact`, `warn`, `allow` (13.2). Edit profiles under **Settings, Guards** and per catalog entry; per-tool profiles
live in overrides.

**Model guards send content out of the deployment. Know where it goes before you enable one.**

| Guard | Where scanned text goes | Notes |
| --- | --- | --- |
| `jev` (TypeSafe Jev) | TypeSafe's hosted API (`api.typesafe.ai`). **Tool arguments, results and descriptions leave your network.** | Request TypeSafe's zero-data-retention option. Pinned model version (never `jev-latest`). Thresholds block 0.85, quarantine 0.6, warn 0.4. Timeout 1.5 s, default fail-open (applies `warn`). |
| `llmJudge` | Whatever OpenAI-compatible endpoint you configure (vLLM, Ollama, LiteLLM, OpenAI, Azure OpenAI). | Data stays inside your boundary only if the endpoint does. Timeout 3 s. |
| `classifier` | A self-hosted Text Embeddings Inference `/predict` endpoint (recommended: Llama Prompt Guard 2, 86M, CPU). | Data never leaves the deployment: the default choice for regulated environments. Timeout 0.5 s. |

Configure endpoints and credentials once in org settings (`modelGuards`, secrets stay in the secret store), then
reference them in profiles. Model guards never override a deterministic guard that blocked. Results are cached 24 hours
by content hash. Set `failMode: closed` only where an outage of the guard should stop traffic.

Tool-definition pinning: every tool, prompt, resource and template definition is hashed; drift follows the entry's
`onDrift` (`hideChanged` default, `block`, `warn`) and creates a review item ([runbook](runbooks/drifted-tool-definitions.md)).
Session risk escalation (`confirm` after repeated suspicious findings) is configured in profiles (13.7).

## 10. Limits, quotas and retention

Rules (Admins org-wide, Managers for their teams) cover `rate`, `quota` and `concurrency` per user, team, role,
service account, org or OAuth client (14.1). Defaults (14.3): 600 calls/min per user (burst 100), 20 concurrent per
user, 3,000/min per service account (burst 500), 10 running sandboxes per user, 200 sampling requests per day.
A per-IP flood limit (1,000/min on `/mcp*`, 60/min on token and registration endpoints) runs before body parsing.
When Redis is down, limits fall back to a per-worker limiter at `1/BASTION_EXPECTED_WORKERS` of each rule (the chart
sets that variable from your worker replica count).

| Retention | Default | Where |
| --- | --- | --- |
| Call log | 30 days | `logs.retentionDays`; daily partitions are created 7 days ahead and dropped after retention. |
| Argument and result previews | off | `logs.capturePreviews`; 2 KiB redacted previews when on. |
| Audit log | 365 days | `audit.retentionDays`; hash-chained, `GET /api/v1/audit/verify`; CSV, JSON, OTLP and signed webhook export. |
| Rollups | minute 7 days, hour 90 days, day 2 years | Fixed. |
| Distribution events (plugins) | 90 days | Fixed. |

Other org settings: `personalInstalls` (`remoteOnly`), `clientRegistration` (CIMD and DCR on, DCR 10 per IP per hour),
`tokens` (access 900 s, refresh 30 days, idle 7 days, PAT maximum 90 days), `registry.defaultSourceEnabled` (false).

## 11. Observability

OTLP traces, metrics and logs (15): set the standard `OTEL_EXPORTER_OTLP_*` variables through `env`, or enable
`otelCollector` and the chart points Bastion at it (`OTEL_EXPORTER_OTLP_ENDPOINT=http://<release>-otel-collector:4318`).
The collector keeps all error traces and 10% of the rest by default. `BASTION_TRACE_SAMPLE_RATIO` (1.0),
`BASTION_PROMETHEUS_PORT` (off), `BASTION_TRACE_UI_URL` (a trace-viewer template for UI links),
`BASTION_OTEL_CAPTURE_CONTENT` (off: records tool arguments and results on spans). Health: `/healthz` (alive),
`/readyz` (Postgres, Redis, migrations; on workers also the sandbox driver and internal RPC listener),
`/api/v1/system/status` (Admin). Keep your own dashboards on `bastion.limits.degraded`, `bastion.calllog.dropped`,
`bastion.sandbox.starts` and `mcp.server.operation.duration` (15.3).

## 12. Backups and disaster recovery

| What | How | Notes |
| --- | --- | --- |
| Postgres | Your platform's backups and point-in-time recovery (`pg_dump` for logical copies). | Holds configuration, catalog, users, encrypted secrets, call and audit logs. Test restores. |
| **The KEK / KMS key** | Local: copy the key file to a vault. Cloud KMS: do not schedule the key for deletion; enable the provider's key-version retention. | **Without it every encrypted secret is unreadable.** Back it up separately from the database. |
| Internal secret | Kept in your secret manager. | Regenerable (it only signs worker-to-worker requests). |
| Redis | No backup needed. | Holds sessions, leases, caches and limits: after a loss, users sign in again and sandboxes re-attach. |
| `/var/lib/bastion` (bubblewrap) | Volume snapshot if persistent workspaces matter. | Kubernetes persistent workspaces live in PVCs in `bastion-sandboxes`. |
| Configuration as code | `bastion export-config` and `bastion import-config`. | Use for promoting configuration between environments and as a human-readable backup of catalog and settings; it is not a substitute for database backups. |

To restore: restore Postgres, make the same KMS key available, deploy the same or a newer chart version (migrations
run in the pre-upgrade Job), and start workers. After a Postgres restore older than the last key rotation, the `as`,
`state` and `upstream-client` keyrings come back from the backup, which is consistent.

## 13. Upgrades

Migrations follow **expand then contract across two releases**: release N adds columns and tables that old code
ignores; release N+1 removes what N stopped using. A rolling upgrade with old and new replicas side by side is
therefore safe, but do not skip releases (go through each, so a contraction never runs before its expand has been
live). The internal RPC is versioned (`/internal/v1`) and each release supports the previous version.

```sh
helm upgrade bastion oci://ghcr.io/bastion-mcp/charts/bastion --version <new> -n bastion --reuse-values
```

The `pre-upgrade` Job runs `bastion migrate` first; if it fails the upgrade stops before any pod changes
(`kubectl -n bastion logs job/bastion-migrate-<revision>`; hook Jobs are deleted when they succeed). Worker
pods drain for up to 25 s on SIGTERM, close streams gracefully, delete their leases, and leave sandboxes running to be
re-attached by whichever worker serves the next request. `PodDisruptionBudget` and `maxUnavailable: 0` keep capacity
during the roll. **Rollback** with `helm rollback` is safe to the previous release because of expand-then-contract; it
is not safe across a release whose migration contracted a column your target still uses.
`deploy/upgrade/test-upgrade.sh <previous> <new|local>` runs the upgrade on kind with traffic (not yet run end to
end, see section 0).

Before every upgrade: back up Postgres, read the release notes, and run `helm upgrade --dry-run`.

## 14. The `bastion` CLI

Shipped in the main image (also as `node dist/main.js <command>`); in Kubernetes run it with
`kubectl exec deploy/bastion-ui -- bastion <command>`. It reads the same configuration as the server and refuses to
run on invalid configuration, printing every error.

| Command | Purpose |
| --- | --- |
| `bastion migrate` | Apply database migrations (Prisma `migrate deploy`). Run by the Helm hook and the compose `migrate` service. |
| `bastion check-config` | Validate the effective configuration (environment plus `BASTION_CONFIG_FILE`) without starting. |
| `bastion create-admin --email <email>` | Create a local break-glass admin. |
| `bastion set-role --email <email> --role admin\|auditor\|member` | Give an existing account an organization role (for example to make an identity provider account an administrator). Audited; refuses to demote the last active administrator. |
| `bastion reset-password --email <email>` | Set a new password for a local account: a random one printed once, or yours with `--password-stdin`. Signs the account out everywhere and revokes its tokens. |
| `bastion rotate-keys --purpose as\|state\|upstream-client` | Rotate one keyring (see [rotating keys](runbooks/rotating-keys.md)). |
| `bastion export-config` | Write catalog and settings as portable configuration. |
| `bastion import-config` | Load such a file. |

The design fixes these commands and the flags shown; any other flags (output path, dry run) are not specified yet.
Check `bastion <command> --help` in your build.

## 15. Sizing

| Org size | Workers | ui | Postgres | Redis | Sandbox nodes |
| --- | --- | --- | --- | --- | --- |
| Up to 200 users | 2 (or 1 `all`) | 1 | 2 vCPU, 8 GiB | 1 GiB | 1 node, 8 vCPU |
| 200 to 2,000 | 3 to 6 | 2 | 4 vCPU, 16 GiB, one replica | 2 GiB, HA | 2 to 4 nodes |
| 2,000 to 10,000 | 6 to 20 | 3 | 8 vCPU, 32 GiB, one replica | 4 GiB, HA | 4 to 12 nodes |

Each worker targets 1,000 concurrent downstream streams and 100 owned instances. Performance targets checked by the load
suite are in tdd 23.4 and encoded in `packages/testkit/load/src/scenarios.ts`.

## 16. High availability and failure modes

Any replica can serve any request; the only affinity is for live stateful upstreams (sandboxes, legacy remote
sessions), owned by one worker at a time through a 15 s Redis lease; other workers forward over port 7443. The ui
scheduler runs on one replica, elected by a Postgres advisory lock. What happens when a dependency fails, and what to do,
is in the runbooks:
[worker crash](runbooks/worker-crash.md), [Redis](runbooks/redis-outage.md), [Postgres](runbooks/postgres-outage.md),
[KMS](runbooks/kms-unreachable.md), [sandbox starts](runbooks/sandbox-start-failures.md),
[drifted definitions](runbooks/drifted-tool-definitions.md), [mirror diverged](runbooks/mirror-diverged.md),
[key rotation](runbooks/rotating-keys.md), [IdP down](runbooks/idp-down.md).

In-cluster traffic (worker to worker, worker to sandbox, to Postgres and Redis) is authenticated and restricted by
NetworkPolicy but **not encrypted by Bastion**: enable CNI transparent encryption (Cilium or Calico WireGuard) or a mesh
with mTLS, and use `sslmode=verify-full` and `rediss://` (22.4).
