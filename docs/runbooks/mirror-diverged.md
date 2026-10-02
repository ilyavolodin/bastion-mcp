# Runbook: plugin mirror diverged

A marketplace may have one **mirror** target (a GitHub or GitLab repository) that claude.ai and ChatGPT sync from
(25.5). After each release the scheduler pushes the release commit and tag as a **fast-forward**. If the remote branch
has diverged, the mirror is marked `diverged` and pushing **stops**; Bastion never force-pushes.

## Symptoms

- The marketplace page shows the mirror as `diverged`, or failed pushes with the retry schedule (1, 5, 15, 60 minutes).
- claude.ai or ChatGPT consoles show stale plugin versions; the daily vendor sync finds nothing new.
- Audit events for mirror pushes stop.

## Causes

- Someone pushed to, or edited files in, the mirror repository (it must be dedicated to Bastion and private).
- The repository was recreated, force-pushed, or had its default branch changed.
- Repository protection rules reject Bastion's push (branch protection, required reviews, signed commits).
- Credentials: GitHub App installation token lacks `contents: write` or the installation was suspended; GitLab project
  access token expired or lacks `write_repository`.

## Diagnose

```sh
# Compare the mirror with the release Bastion built (the git channel is the source of truth):
git ls-remote https://github.com/<org>/<mirror>.git refs/heads/main
git -c credential.helper= ls-remote https://x-access-token:<token>@mcp.example.com/plugins/<slug>.git refs/heads/main
git log --oneline <mirror-main>..<bastion-main>   # after fetching both
git log --oneline <bastion-main>..<mirror-main>   # commits on the mirror that Bastion did not create
```

Releases are deterministic: Bastion's commits have author `Bastion <noreply@bastion-mcp.github.io>`, message
`Release <N>`, and fixed timestamps. Any commit on the mirror not authored that way is foreign.

## Act

1. Decide whether the foreign commits matter. They are not part of any Bastion release and will be discarded by a reset.
   Save anything valuable elsewhere first.
2. **Reset the mirror from the marketplace page** (admin action: it resets the mirror to Bastion's current release).
   Bastion itself never force-pushes on its own initiative; the reset is the explicit, audited override. If your build
   offers no reset button, recreate the target repository (empty, private) and re-add it.
3. Fix the cause: restrict write access to Bastion's identity, turn off branch protection that blocks fast-forwards
   from the app, renew the token.
4. Trigger a push (a new release, or the marketplace page's sync action) and watch the retry state clear.
5. Ask the vendor consoles to **Sync now** (claude.ai Organization settings, Plugins and skills; ChatGPT Admin, Plugins),
   or wait for the daily sync.

## Verify

The mirror's `main` equals Bastion's `main` commit SHA, tag `release-<N>` exists on both, the marketplace page shows the
mirror healthy, and the consoles list the current plugin versions.

## Afterwards

Never use the mirror as an authoring location. Reminder: mirrored plugins reference `https://<host>/mcp/c/...`; vendor
clouds call that URL from the internet, so `/mcp` must be reachable for them.
