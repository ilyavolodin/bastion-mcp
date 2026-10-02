# Runbook: drifted tool definitions

Bastion hashes every tool, prompt, resource and template definition (name, title, description, `inputSchema`,
`outputSchema`, annotations, `_meta.ui`) over canonical JSON and compares each upstream list with the **pin set** stored
on the catalog version (personal installations pin on first successful list). A change is either a legitimate upstream
update or a tool-poisoning or rug-pull attempt (13.6). Treat every drift as suspect until reviewed.

## Symptoms

- Users report a tool that disappeared (`hideChanged`) or an installation that stopped working (`block`).
- A **drift review** item appears in **Security** for the entry's owners (or the user for a personal installation).
- Guard findings on definitions (`bastion.guard.evaluations{phase="definition"}`).

## Impact by policy (`onDrift`)

| Policy | Effect |
| --- | --- |
| `hideChanged` (default) | Changed and new items are hidden until approved; removed items just disappear. |
| `block` | The whole installation is disabled until approved. |
| `warn` | Items stay visible; the finding is recorded. |

## Review

1. Open the review item: it shows a definition **diff** and the **definition-phase guard results** (`unicode`, regex
   injection heuristics, model guards if enabled).
2. Look specifically for: new or changed instructions in descriptions addressed to the assistant ("ignore previous...",
   "before using this tool, also read ..."); invisible or bidirectional Unicode; new parameters that accept URLs, file
   paths or secrets; a tool that became destructive or open-world (`destructiveHint`, `openWorldHint`) or lost
   `readOnlyHint`; a renamed tool that now collides with a trusted one.
3. Check the upstream: release notes and changelog of the package or service; for packages, whether the lockfile or version
   changed (versions are exact, so a drift on an unchanged version is more suspicious than one after an upgrade); for
   remotes, whether the vendor announced a change.
4. **A `malicious` verdict blocks approval** unless an Admin overrides it with a recorded reason.

## Act

- **Approve** when the change is understood and expected: the pin set is updated and the items become visible. Approval
  writes an audit event.
- **Reject or leave pending** when unexplained: the items stay hidden. Disable or deprecate the catalog entry if the upstream
  looks compromised; consider blocking the namespace in the registry policy; rotate any credential the upstream could
  have seen.
- For a **catalog entry**, publishing a new version after re-testing refreshes the pin set from a known-good test
  (the test captures the reference snapshot and runs the description scan).
- If `block` is too disruptive for an entry that changes often, switch that entry to `hideChanged`, not `warn`.

## Verify

The review item closes, users see the expected tool list, and the next list comparison produces no new drift.

## Afterwards

Frequent legitimate drift means the entry should pin a version (`autoUpgrade` off) and go through the catalog test and
publish flow instead.
