# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**. Do not open a public issue or pull request.

1. Use GitHub private vulnerability reporting on this repository: **Security, Report a vulnerability**
   (`https://github.com/bastion-mcp/bastion-mcp/security/advisories/new`).
2. Include: the affected component and version (image digest or chart version), a description and impact, steps to
   reproduce or a proof of concept, and whether you believe it is already being exploited.
3. Do not include real credentials, customer data or production secrets. If you accidentally obtained any, say so and do
   not retain them.

> Maintainers: a monitored security mailbox has not been configured yet. Add one here (and enable private vulnerability
> reporting in the repository settings) before the first release.

## What to expect

These targets are the project's intent; the maintainers confirm them before the first release.

- Acknowledgement within 3 business days.
- An initial assessment (accepted, needs more information, or declined with a reason) within 10 business days.
- A fix or mitigation, and a coordinated disclosure date, agreed with you; we aim to publish fixes for confirmed
  high-severity issues within 90 days of the report.
- Credit in the advisory if you want it.

## Scope

In scope: the Bastion server (worker and ui roles), the sandbox runner and drivers, the egress proxy, the Helm chart and
container images, `bastion-credential`, and the documentation where it would lead operators to an insecure
configuration. Of particular interest: authentication and token handling, SSRF and egress-proxy bypasses, sandbox
escape, cross-user data exposure, secret handling and encryption, guard bypasses that defeat a documented control,
supply-chain integrity of release artifacts.

Out of scope: vulnerabilities in third-party MCP servers you run through Bastion (report them to their authors),
denial of service by volume without an amplification flaw, findings that require a malicious Admin, missing hardening
that the documentation already lists as the operator's responsibility (for example in-cluster encryption, 22.4), and
reports from automated scanners without a demonstrated impact.

## Supported versions

Only the latest released minor version receives security fixes until the project declares a longer support policy.

## Verifying releases

Images and the Helm chart are signed keylessly with cosign and carry SPDX SBOMs and SLSA provenance. See
`docs/admin-guide.md`, section 4, for the verification commands.

More background: [`docs/security.md`](docs/security.md).
