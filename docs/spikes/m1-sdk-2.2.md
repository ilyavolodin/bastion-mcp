# Spike: MCP TypeScript SDK v2 surfaces for M1 (tdd.md 24.2 a, b, c)

Run on 2026-10-01 against `@modelcontextprotocol/core|client|server@2.2.0` and `@modelcontextprotocol/node@2.1.0`
(`node@2.2.0` does not exist; `node` versions independently, peer range `server ^2.1.0`), Fastify 5.12.5.

## (b) `createMcpHandler` with a low-level `Server` factory, `authInfo` through `toNodeHandler` on Fastify: confirmed

- `createMcpHandler(factory, { legacy: 'reject' })` takes a `McpServerFactory(ctx)` where
  `ctx = { era: 'legacy' | 'modern', authInfo?, requestInfo? }`. The factory may return the low-level `Server`.
  It is called **once per HTTP request** (three calls for connect-probe, list and call), so the factory must be cheap and
  read everything from the cached effective endpoint, as 4.3 and 7.2 already require.
- `authInfo` is strictly pass-through. Setting `request.raw.auth = { token, clientId, scopes }` in a Fastify hook before
  calling `toNodeHandler(handler)(req.raw, reply.raw, parsedBody)` reaches `ctx.authInfo` in the factory. The SDK never
  derives it from headers, matching the spec ("the preHandler sets `request.raw.auth`").
- Fastify must not consume the stream twice: register a raw-buffer content-type parser, parse once, and pass the parsed
  body as the third argument of the node handler and to `toWebRequest(req.raw, parsed)` (which is **async**).
  `reply.hijack()` before handing the raw response to the SDK.
- `bus` (a `ServerEventBus`) is injectable, `keepAliveMs` defaults to 15 s (the spec wants a comment every 25 s on idle
  streams: set `keepAliveMs: 25000`), `maxRequestBodySize` defaults to 4 MiB, `maxSubscriptions` to 1,024.
- The built-in `subscriptions/listen` serving uses the bus with no audience. Bastion therefore intercepts
  `Mcp-Method: subscriptions/listen` **before** the SDK, as 6.2 and 6.6 say.

## (c) Legacy adapter in front, selected with `isLegacyRequest`: confirmed

- `await isLegacyRequest(webRequest)` (reads from an internal clone) is `true` for a 2025-era client
  (no `MCP-Protocol-Version` modern envelope, claim-less POSTs, GET/DELETE session operations) and `false` for a
  2026-07-28 client. A client in `versionNegotiation: { mode: 'auto' }` probes with `server/discover` and lands on the
  modern path; a legacy client on a strict `legacy: 'reject'` handler gets `-32022 Unsupported protocol version`, so
  Bastion's own legacy adapter MUST be the branch taken when the predicate is `true`.
- Per the SDK docs, a hand-wired composition must itself answer **415** for POSTs whose media type is not
  `application/json` (`isJsonContentType`) before dispatching either leg, and must send every `false` result (including
  validation-ladder errors) to the modern handler. Host and Origin validation helpers are exported
  (`hostHeaderValidationResponse`, `originValidationResponse`).

## (a) Upstream `InputRequiredResult` with `inputRequired.autoFulfill: false`: confirmed at the type level

- `ClientOptions.inputRequired?: { autoFulfill?: boolean; maxRounds? }`. With `autoFulfill: false` an `input_required`
  response surfaces as a typed error **unless the individual call passes `allowInputRequired: true`**
  (`withInputRequired()` types both outcomes on the explicit-schema path). The pass-through bridge of 6.5 therefore sets
  `autoFulfill: false` on every upstream `Client` and passes `allowInputRequired: true` on `tools/call`,
  `prompts/get` and `resources/read`.
- `isInputRequiredResult`, `inputRequired()`, `InputRequests`, `InputResponses` and `RequestStateAccessor` are exported
  from `@modelcontextprotocol/server`; the client library has `Implementation`/`UriTemplate` helpers (`UriTemplate.match`
  for the URI index, 7.4).
- The server `Server` class contains its own legacy `input_required` shim. Bastion does **not** use it: continuations
  across replicas (6.5) need Redis-backed state, so the operation layer converts eras itself.

## Consequences for the implementation

1. Pin `@modelcontextprotocol/core|client|server` to `2.2.0` and `@modelcontextprotocol/node` to `2.1.0`; record the
   split in the PR that adds them.
2. `mcp-downstream` owns the Fastify hook order: flood limit, then token verification, then `request.raw.auth`, then
   `subscriptions/listen` interception, then `isLegacyRequest` branch.
3. Upstream `Client` instances are created with `versionNegotiation: { mode: 'auto' }` for remotes and
   `inputRequired: { autoFulfill: false }` everywhere.
