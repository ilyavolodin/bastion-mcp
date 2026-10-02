# Runbook: identity provider down

## Symptoms

- Users cannot sign in to the UI or complete a client's first OAuth login; the login page errors after redirect.
- Calls to upstreams in `enterpriseManaged` or `tokenExchange` mode fail with `-32010` (the IdP refused or is unreachable).
- SCIM pushes from the IdP fail, or provisioning/deprovisioning lags.

## Impact (21.3)

- **Existing Bastion access tokens keep working until they expire** (15 minutes by default), and refresh tokens keep
  minting new access tokens (they do not call the IdP), so connected AI tools typically keep working for the length of
  their refresh lifetime (30 days absolute, 7 days idle) unless a policy needs the IdP.
- **Cached upstream tokens keep working.** IdP-minted upstream tokens (`enterpriseManaged`, `tokenExchange`) cannot be
  renewed once cached ones expire (cached until 60 s before expiry).
- New logins and new client authorizations fail. Break-glass access remains available if local login is enabled.
- Deactivations pushed over SCIM are delayed: a deprovisioned user keeps access until the SCIM update arrives or an
  admin deactivates them in Bastion. In an incident involving a compromised account, **deactivate in Bastion directly**
  (revokes tokens and sessions, stops instances, deletes upstream tokens).

## Diagnose

```sh
kubectl -n bastion logs deploy/bastion-ui --tail=200 | grep -i -E 'oidc|idp|discovery|token endpoint|scim'
curl -sS -o /dev/null -w '%{http_code}\n' https://<idp>/.well-known/openid-configuration
```

Check the IdP status page, the connection's discovery URL and client secret (secrets expire: Entra client secrets
commonly expire after 6 to 24 months), clock skew between ui pods and the IdP, egress from the cluster to the IdP, a
changed redirect URI, and a certificate chain the pods do not trust (`BASTION_EXTRA_CA_CERTS`).

## Act

1. **IdP outage (provider side)**: wait; communicate that signed-in tools keep working. Do not disable SSO.
2. **Misconfiguration on our side** (expired secret, wrong discovery URL): update the connection in **Settings, Identity
   providers** (or the secret behind it), and test a login.
3. **Urgent admin access with the IdP down**: use the break-glass local admin. It works only while no IdP connection
   exists or while `BASTION_LOCAL_LOGIN=true`; to enable it temporarily set `localLogin=true` and roll the ui Deployment, and
   turn it off afterwards. Keep the credential sealed and audited.
4. **Several IdP connections**: the login page routes by email domain; users of the healthy connection are unaffected.

## Verify

A fresh login succeeds end to end (browser and an AI tool); IdP-minted upstream calls work; SCIM catches up (check the IdP
provisioning log and Bastion's audit events); local login is disabled again.

## Afterwards

Put IdP client-secret expiry dates in your calendar. Consider a second IdP connection or a documented break-glass path for
your on-call admins.
