# Bastion user guide

Bastion is your organization's gateway to MCP servers: you sign in once with your company account, install the
servers you need from an approved store, and point your AI tools at one URL. This guide is for people who use it.
Administrators: see [`admin-guide.md`](admin-guide.md). Section numbers refer to [`tdd.md`](tdd.md).

> Status note: this guide describes the specified behavior. The web UI (`apps/web`) was not built yet when it was
> written, so button names follow the design (`docs/design`, tdd 18) and may differ slightly. The **Home** page of your
> Bastion shows copy-ready configuration for each tool and is the authority for exact values.

Replace `https://mcp.example.com` with your organization's Bastion address everywhere below.

## 1. The three kinds of URL

| URL | What you get | Tool names |
| --- | --- | --- |
| `https://mcp.example.com/mcp` | **Everything you can use**: all your enabled installations as one server. | Prefixed with the installation, for example `github__create_issue`. |
| `https://mcp.example.com/mcp/e/{slug}` | A **named endpoint**: a subset of your installations that you chose in **My servers**. | Prefixed. |
| `https://mcp.example.com/mcp/i/{slug}` | **One installation** only, for example `/mcp/i/github`. | The server's own names, unchanged. |

Who you are comes from your sign-in token, never from the URL. Use named endpoints or single installations when a
tool gets confused by a long tool list: the UI shows each endpoint's tool count and warns past 40 tools, with one-click
ways to split it or hide tools. Teams' installations also appear in your default endpoint; their effective slug is
`{teamSlug}-{slug}`.

## 2. Connect your AI tool

All clients sign in through your browser the first time (OAuth against Bastion, which in turn signs you in with your
company identity provider). The consent page names the client and the address it will return to; check it.

### Claude Code

```sh
claude mcp add --transport http bastion https://mcp.example.com/mcp
```

Then run `/mcp` inside Claude Code, pick `bastion`, and choose Authenticate. To use a single server:
`claude mcp add --transport http github https://mcp.example.com/mcp/i/github`.

### Claude Desktop (and claude.ai)

Add Bastion as a custom connector: **Settings, Connectors, Add custom connector**, name it, paste
`https://mcp.example.com/mcp`, and complete the sign-in. Your administrator may already have added it for your
organization. (Claude Desktop's local `claude_desktop_config.json` is for local stdio servers; use the connector
for a remote URL.)

### Cursor

Open **Settings, MCP** (or edit `~/.cursor/mcp.json`) and add:

```json
{ "mcpServers": { "bastion": { "url": "https://mcp.example.com/mcp" } } }
```

Cursor opens the browser to authenticate when the server first needs it.

### VS Code (GitHub Copilot)

Create `.vscode/mcp.json` in a workspace, or use **MCP: Add Server** and choose HTTP:

```json
{ "servers": { "bastion": { "type": "http", "url": "https://mcp.example.com/mcp" } } }
```

If your organization points VS Code at Bastion's enterprise registry, Bastion shows exactly the servers your
organization allows, each as `https://mcp.example.com/mcp/i/{slug}`.

### Scripts and CI

Create a personal access token under **Settings, Tokens** (maximum lifetime 90 days) and send it as
`Authorization: Bearer bst_pat_...`. Service accounts are for shared automation and are created by team managers.

## 3. Install servers from the store

1. Open **Store**. Search by name, tag, or what you want to do: search also covers tool names and descriptions, so
   "create jira ticket" finds the Atlassian server.
2. Each card shows how it runs (Remote, npm, Python), what it needs ("Connect with OAuth", "Needs your API key",
   "Ready to use"), the isolation level, and the network hosts it can reach. Click a card to see its tools.
3. Click **Install**. Fill in the form if it asks for variables or your own API key (stored encrypted and visible only
   to you), then finish with **Connect** if it uses OAuth.
4. The **Ready** screen shows your endpoint URL and copyable configuration for Claude Desktop, Claude Code, Cursor and
   VS Code.

Some servers are installed for you by policy (**required**: cannot be removed; **default**: you may remove it).
Installations that need a key or a login show a banner on **Home** with the action ("Add API key", "Connect GitHub").
An installation that still needs a personal key is left out of your endpoints until you provide it.

### Servers from external registries

**Registry** lets you browse public MCP registries your administrator enabled. Depending on policy, Install runs
immediately ("direct"), opens a request for your manager or an administrator to approve ("request"), or only shows
"Ask your admin". Bastion tests the server first (lockfile, tool list, security scan) before it creates the
installation.

## 4. Connect OAuth for an upstream

Servers such as GitHub, Linear or Notion use their own login:

- Click **Connect** on the installation, review the page (it names the installation and the sign-in host), and approve
  at the provider. Tokens are stored encrypted, bound to you and that one server, and are never shown.
- If you call a tool before connecting, your AI tool receives a link to connect (or a clear `-32015` "upstream auth
  required" error with the same link). Open it, connect, and retry.
- If the provider revokes your access or a refresh fails, the installation shows **Reconnect required**; click it.

## 5. Overrides: shape the tools you see

Open an installation's **Overrides** tab to change what your AI tool sees (12): hide tools you never want the model to
use, rename them or rewrite descriptions so the model picks better, fill default arguments, or pin an argument so
the model cannot change it (for example always `repo: acme/web`). What you may change depends on the catalog entry
(`none`, `cosmetic`, or `full`). Safety annotations such as `readOnlyHint` can be edited only by the entry's owners,
because access policy reads them. The **Capabilities** tab shows the final result, with a pencil marker on changed
items and an eye-off marker on hidden ones.

## 6. Plugins and skills for Claude Code and Codex

**Plugins** (in the navigation) are bundles of skills, commands and MCP server connections that your organization
publishes in marketplaces. Plugins point at Bastion's own endpoints (`/mcp/c/{catalogSlug}`), so the same plugin works
for every user and the tools inside it run through Bastion with your access, guards and limits.

Open **Plugins**, pick a marketplace, and use **Set up** for your tool. The page generates the exact commands. In
general:

**Claude Code**

```sh
git config --global credential.https://mcp.example.com.helper "<path>/bastion-credential"
claude plugin marketplace add https://mcp.example.com/plugins/<marketplace>.git
claude plugin install <plugin>@<marketplace>   # or inside Claude Code: /plugin marketplace add ... and /plugin install ...
```

**Codex CLI** (and the Codex app)

```sh
git config --global credential.https://mcp.example.com.helper "<path>/bastion-credential"
codex plugin marketplace add https://mcp.example.com/plugins/<marketplace>.git
```

Items marked **required** by your administrator are enabled for you through managed settings; items marked
"installed by default" show up on **Home** as a single install command for Claude Code.

**Claude on the web, Claude Desktop with your organization account, and ChatGPT** get plugins from your administrator's
console (a mirror repository), not from commands you run.

### The credential helper

Plugin marketplaces are private git repositories behind your Bastion login. `bastion-credential` is a small helper
that signs you in once and answers git's credential requests:

- Download it from the release assets (macOS arm64 and x64, Windows x64, Linux x64 and arm64) and put it on your
  `PATH` (or deploy it with your device management tool).
- It finds your server from the `BASTION_URL` environment variable or `~/.config/bastion/credential.json`:
  `{ "url": "https://mcp.example.com" }`.
- The first time (and when its refresh token expires) it shows a short code and opens your browser (OAuth device
  authorization). The refresh token is stored in your operating system keychain; access tokens live in memory only.
- `bastion-credential get` speaks the git credential protocol; `bastion-credential token` prints a bare token (the
  form Claude Desktop's `credentialHelper` setting expects).
- No helper? Create a token with the `plugins:read` scope under **Settings, Tokens**, and store it in your git
  credential manager with username `x-access-token`. A `plugins:read` token only works on `/plugins/*`.

macOS and Windows builds are signed and notarized only when your organization's release pipeline has the certificates;
unsigned builds trigger an operating-system warning, and you may need your administrator's approval to run them.

## 7. Your activity and limits

**Activity** shows your own calls with timing and, where enabled, a trace. Quotas appear as progress bars on **Home**.
When a call is rejected, the tool result says why and when to retry. Teams' managers can see their members' activity if
the organization enabled it.

## 8. Troubleshooting

| What you see | Meaning and what to do |
| --- | --- |
| Browser sign-in loops or "access denied" | Your account is not provisioned or has no role. Ask your administrator; check that you used your company account. |
| `401` with `WWW-Authenticate: Bearer ...` from your tool | The token expired or the tool did not complete sign-in. Re-authenticate (`/mcp` in Claude Code) or sign in again. |
| `403 insufficient_scope` | The token lacks a scope (for example a `plugins:read` token used on `/mcp`). Create the right kind of token. |
| `-32015` upstream auth required | Connect the installation (section 4) using the link in the message. |
| `-32010` policy denied | Your role or the entry's rules forbid this tool. Ask a team manager. |
| `-32011` rate limited / `-32012` quota exceeded | Wait for `retryAfterMs` or the reset time in the message; ask for a higher limit if you need it. For `-32011` on sandboxes, you also may be at your running-sandbox limit (10): stop one you do not use. |
| `-32013` guard blocked | A security guard flagged the request or response (for example a secret or an injection-like instruction). Rephrase, or ask a manager to review the guard finding in **Security**. |
| `-32014` upstream unavailable | The server (or its sandbox) was lost or is unreachable. Retry; if it persists, check the installation page for the last error. |
| `-32016` sandbox start failed | The package could not be installed or started. The installation page shows the phase and the last stderr lines. After repeated failures Bastion waits (5 s, 30 s, 2 min, 10 min) before retrying; **Restart** retries immediately. |
| `-32017` upstream timeout | The server took too long. Retry with a smaller request. |
| A tool disappeared or is "hidden" | Its definition changed upstream and is waiting for approval (a security review). Your administrator or the entry's owner approves it in **Security**. |
| A tool is missing from `/mcp` but exists in `/mcp/i/{slug}` | The installation is disabled, missing a personal key (`needs_setup`), or hidden by an override. Check **My servers**. |
| Claude Code does not list a plugin | Check the git credential line, run `bastion-credential token` to confirm sign-in, and that your account is in the marketplace's audience (people outside it get `404`). |
| Streams or long calls cut off after a long time | An intermediary has a shorter idle timeout than Bastion's keep-alives; tell your administrator (the chart sets one hour). |
| Odd behavior in an old client | Bastion speaks both the 2026-07-28 and the older 2025 protocol revisions; a client that sends no protocol version is treated as 2025-03-26. Update the client if a feature is missing. |

Tell your administrator the time of the failure and the request ID shown in **Activity**: every call has a trace.
