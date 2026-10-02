# Bastion security

Summary of the security model for operators and reviewers. The authoritative text is `tdd.md` section 22; this page
adds how to verify each control and how to report problems. To report a vulnerability, see
[`SECURITY.md`](../SECURITY.md) at the repository root.

## 1. Model in one paragraph

Bastion treats every upstream server, every sandboxed package and all content flowing through it as untrusted. It trusts
only its own processes, Postgres, Redis and the KMS. Every credential is encrypted and bound to one user and one
upstream. The token an MCP client presents to Bastion is never forwarded upstream (the MCP authorization spec forbids
token passthrough): each upstream gets its own credential for that user.

## 2. Trust boundaries and controls (22.1)

| Boundary | Untrusted side | Controls |
| --- | --- | --- |
| MCP clients to workers | Client requests, `requestState`, task IDs, cursors | Token verification (audience-bound JWT or hashed PAT), header-body validation, AEAD-wrapped state, Cedar authorization, limits, request guards |
| Workers to remote upstreams | Upstream results and definitions | Response and definition guards, definition pinning, size caps (32 MiB per message, 100 MiB per stream), SSRF checks, TLS required except `BASTION_INSECURE_UPSTREAM_HOSTS` |
| Workers to sandboxes | Everything the package does | gVisor or Kata (or namespaces with seccomp), no service account, egress through the proxy only, read-only root, resource limits, per-claim runner token |
| Browsers to ui | Form input, uploads | Session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`), double-submit CSRF, zod validation, strict CSP, Cedar |
| Bastion to model guards | Jev and LLM endpoints see scanned text | Opt-in, documented data flow, pinned versions |
| Registries to catalog | `server.json` content, packages | Install policy, automatic test, exact versions and lockfiles with integrity checks, OSV check, definition scan |

## 3. Threats and mitigations

The design's threat table (22.2) is empty in the copy of `tdd.md` this page was written from (the rows were lost in
the export), so the table below is derived from the boundaries above and the mechanisms specified in sections 6 to 15.
It is a summary, not the reviewed threat model: **the threat-model review is part of milestone M8's gate (24.1) and is
still to be done.**

| Threat | Mitigation | Where |
| --- | --- | --- |
| Stolen or replayed client token | 15 minute JWTs, audience-bound to `https://<host>/mcp` (RFC 8707), refresh-token rotation with reuse detection (a reused token revokes its family), PATs stored as SHA-256 with a 90 day maximum | 9.3 |
| Confused deputy / token passthrough | Bastion never forwards the client's token upstream; per-upstream credentials (OAuth per user, IdP-minted, secrets) | 9.5 to 9.7 |
| Tool poisoning, rug pull | Definition pinning (SHA-256 over canonical JSON), drift policy `hideChanged`/`block`, description scanning, approval flow | 13.6 |
| Prompt injection in results | Deterministic guards on every call (unicode smuggling, regex presets), optional model guards, quarantine envelope, session risk escalation to `confirm` | 13 |
| Secret leakage in arguments or results | `regex` secrets preset (redact on responses, warn on requests), previews off by default, log redaction, content capture off | 13.4, 15.4 |
| SSRF from remotes or sandboxes | Address checks on remote URLs and in the egress proxy: resolve once, deny loopback, link-local (including the metadata address), RFC 1918, CGNAT, ULA and cluster CIDRs, connect to the resolved address (no DNS rebinding) | 8.8, 8.9 |
| Malicious package or dependency confusion | Exact versions, captured lockfiles with hashes, install scripts off, mirrors, OSV `MAL-` check, `minIsolation` | 8.7 |
| Sandbox escape, lateral movement | gVisor or Kata, uid 1000, read-only root, no capabilities, no service account token, NetworkPolicy to worker pods only on 8080 and 3128, no DNS, per-instance egress token | 8.4, 8.8 |
| Cross-user data exposure | Credentials bound to (user, installation); shared instances only for `none`/`orgSecret` auth; `{{user.*}}` templates rejected on shared entries | 8.6, 9.5 |
| Forged internal RPC | HMAC-SHA256 over timestamp, method, path and body hash with `BASTION_INTERNAL_SECRET`, 30 s skew, NetworkPolicy 7443 workers-only | 21.2 |
| Stored secret theft from the database | Envelope encryption (AES-256-GCM per row, KMS-wrapped data key, AAD binds scope, owner, name and version) | 22.3 |
| Tampered state, cursors, task IDs | AES-256-GCM `state` keyring, bound to the principal, expiring, daily rotation | 22.3 |
| Malicious or compromised registry | Registry content is untrusted: policy, request approval, tests, definition scan, OSV | 11.6, 11.7 |
| Executable content in plugins | Classified per file; publishing a version with executable content needs Admin approval of that exact version with the reviewed diff | 25.2 |
| Audit tampering | Hash-chained audit events, `GET /api/v1/audit/verify`, OTLP and webhook export | 15.6 |
| Abuse of registration endpoints | DCR rate limit (10/IP/hour), redirect URI rules, CIMD host allowlist, pre-auth flood control | 9.3, 14.2 |

## 4. Keys and encryption (22.3)

Per-row data keys (AES-256-GCM, random 96-bit IV, AAD `scope|owner_id|name|version`) wrapped by the KMS key. Keyrings
(`as` 30 days, `upstream-client` 90 days, `state` daily) live as `system` secrets. Break-glass password hashes use
argon2id (64 MiB, 3 iterations). `BASTION_INTERNAL_SECRET` signs internal RPC. Rotation procedures:
[`runbooks/rotating-keys.md`](runbooks/rotating-keys.md).

## 5. Transport security (22.4)

- **External:** TLS terminates at the ingress. Bastion sets HSTS (`max-age=31536000`) and a strict CSP
  (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`).
- **In cluster:** traffic is authenticated (tokens, HMAC, credentials) and restricted by NetworkPolicy, but **not
  encrypted by Bastion**. Deployments that require encryption in the cluster MUST enable CNI transparent encryption
  (Cilium or Calico WireGuard) or a service mesh with mTLS, and use TLS to Postgres (`sslmode=verify-full`) and Redis
  (`rediss://`).
- The Helm chart's NetworkPolicies: workers accept 8080 from the ingress controller, 7443 from workers and 3128 from the
  sandbox namespace; ui accepts 8080 from the ingress controller; sandbox pods accept 8080 only from worker pods and may
  send only to worker pods on 3128. They only take effect with a CNI that enforces NetworkPolicy.

## 6. Secure defaults checklist (22.5) and how to verify

| Default | Verify |
| --- | --- |
| Personal package installs off | Org setting `personalInstalls` is `remoteOnly` (default) or `off` |
| Executable plugin content needs Admin approval per version | Try publishing a plugin with `scripts/` as a Manager: it stays pending |
| Registry installs in `request` mode, official registry disabled | `registry.defaultSourceEnabled` is `false`; the policy `mode` is `request` |
| OSV check on | `BASTION_OSV_CHECK` is `true` (default) |
| Install scripts off | Catalog entry `allowInstallScripts` is off unless an admin enabled it |
| Argument and result previews off | `logs.capturePreviews` is `false` |
| Content capture on spans off | `BASTION_OTEL_CAPTURE_CONTENT` is `false` |
| Model guards off (no data leaves) | `modelGuards` is `{ jev: null, llmJudge: null, classifier: null }` |
| Default guard profile on | `guards.orgDefaultProfileId` is the shipped profile |
| DCR rate-limited | `clientRegistration.dcrPerIpPerHour` is 10 |
| PAT maximum 90 days | `tokens.patMaxDays` is 90 |
| Sandboxes have no network except the proxy | `kubectl -n bastion-sandboxes get sandboxtemplate -o yaml` shows the egress rule to worker pods on 3128 only, and `networkPolicies.enabled` is `true` |
| Local password login off once SSO works | `localLogin: false`, and an IdP connection exists |
| Cluster CIDRs denied by the egress proxy | `clusterCIDRs` is set in Helm values |
| Image provenance | `cosign verify` and `gh attestation verify` (admin guide, section 4); pin by digest |

Chart-specific hardening already on by default: non-root uid 10001, read-only root filesystem, all capabilities dropped,
`RuntimeDefault` seccomp, restricted Pod Security level on the sandbox namespace, no service account token in sandbox
pods, one-hour streaming timeouts only where needed.

## 7. Known gaps and cautions

- Items marked "not exercised" in the admin guide (section 0), especially the bubblewrap seccomp profile and the
  agent-sandbox runtime assumptions in `docs/spikes/m3-agent-sandbox.md`, are unverified until run on live systems.
- Jev scans leave the deployment; use the classifier or an in-boundary LLM judge for regulated data.
- Registry and plugin content is untrusted; approvals are only as good as the reviewer's diff review.
- The break-glass admin is a high-value credential; keep it sealed and audited.

## 8. Reporting a vulnerability

Do not open a public issue. Follow [`SECURITY.md`](../SECURITY.md).
