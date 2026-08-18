# Deployment guide

## Local mode

Local mode binds to loopback by default, stores its database and deployment identity under the configured data directory, serves the built web UI, and launches `goose acp` as a child process for prompt execution. It is intended for a single workstation or evaluation environment.

The development identity shortcut is explicit and loopback-only. Do not use it to represent an OIDC or CAC deployment.

## Persistent mode

Persistent mode is a long-running, single-deployment service. It requires a session secret of at least 32 characters and requires a valid offline license by default. Configure durable storage, file permissions, backup, log forwarding, process supervision, and TLS before exposing the service.

Persistent mode currently uses SQLite in WAL mode. It is suitable for a controlled single-node deployment, not horizontal multitenant SaaS. A future storage adapter can add a clustered database without changing the domain contracts.

## Runtime requirements

Papyrus requires Node.js 24+. Persistent mode fails to start on an older major. Government profiles additionally require a FIPS-validated OpenSSL runtime and fail to start unless Node is launched with `--enable-fips` (or an equivalent FIPS-validated module). Commercial persistent deployments log a warning when FIPS is not enabled.

```bash
node --enable-fips apps/server/dist/index.js
```

See [docs/operations.md](operations.md) for backup, recovery, supervision, and disaster-recovery runbooks.

## Commercial OIDC

Configure issuer, client ID, redirect URI, and—when required—the client secret. Papyrus performs discovery, PKCE, state and nonce validation, ID-token signature verification, and issuer/audience checks. Role and resource assignments remain authoritative in Papyrus; identity-provider group claims do not grant access automatically.

## Government CAC/mTLS

Government profiles require direct TLS configuration with a server certificate, private key, and client-certificate trust bundle. The TLS stack rejects clients whose chain is not trusted. Papyrus binds the authenticated certificate fingerprint to a local user record and uses certificate subject data only for display.

Production deployments must supply approved trust anchors and current revocation material at the TLS boundary. This implementation does not claim to perform agency-specific certificate-policy OID mapping, OCSP operations across disconnected networks, or accreditation decisions.

## Runtimes and models

A runtime record contains an agent `kind` (default `goose`) plus a customer-approved model endpoint. Model credentials are resolved from server environment variables using the runtime's `secretRef`; they are never returned to the browser.

Additional agent runtimes are config entries, not code. Declare them in the YAML config file (`PAPYRUS_CONFIG_FILE`, default `papyrus.yaml`; see `papyrus.example.yaml`):

```yaml
agents:
  opencode:
    command: opencode
    args: [acp]
    env:
      MODEL: "{model}"
      OPENAI_BASE_URL: "{baseUrl}"
      OPENAI_API_KEY: "{secret}"
```

The `env` values are templates with `{model}`, `{baseUrl}`, `{secret}`, and `{provider}` placeholders, applied when the runtime is launched. `licenseAuthorities` (key ID → PEM public key) may live in the same file. The `PAPYRUS_AGENTS_JSON` / `PAPYRUS_LICENSE_AUTHORITIES_JSON` environment variables remain as inline overrides that win over the file.

The runtime's `kind` selects the spec; the per-runtime `command` field (when set) overrides the spec's command.

Papyrus passes goose only Papyrus proxy URLs for configured MCP servers. The proxy token is bound to the session and server and expires after one hour. Tool discovery is filtered to workspace grants, and tool invocation is authorized and audited before forwarding.

The current MCP proxy supports stateless HTTP JSON-RPC. Stateful Streamable HTTP sessions, SSE, and stdio MCP transports are deliberately unsupported until their session and cancellation semantics can be mediated without bypasses.

## ACP gateway (bring-your-own client)

Papyrus runs an ACP gateway that lets arbitrary ACP clients (Zed, VS Code, or a custom client) connect to a supervised runtime behind Papyrus's authentication, authorization, audit, and MCP mediation. Enable it with `PAPYRUS_GATEWAY_ENABLED=true`; it listens on `PAPYRUS_GATEWAY_PORT` (default 3220).

- Clients connect to `https://<host>:3220/acp/<runtimeId>`; the path selects the runtime.
- Identity is established by mutual TLS (`PAPYRUS_GATEWAY_TLS_*`, `requestCert` + `rejectUnauthorized`) and mapped to a local Principal from the client certificate fingerprint. On loopback only, a bearer `PAPYRUS_GATEWAY_DEV_TOKEN` may substitute for mTLS.
- When a principal is assigned to more than one workspace, the client sets the `X-Papyrus-Workspace-Id` header; otherwise the single assigned workspace is used.
- `session/new` is authorized with Cedar and its `mcpServers` are rewritten to Papyrus proxy endpoints; `session/prompt` and tool-call permission requests are authorized and audited before the relay forwards them to goose.

The Papyrus web UI is the administrative/ops surface (roles, assignments, licenses, audit, health); it is not the chat client. Shipping bundled client binaries is deferred.

### Smoke test a client

Run a minimal ACP client against the gateway to verify the full client → gateway → agent path:

```bash
PAPYRUS_SMOKE_URL=http://127.0.0.1:3220/acp/<runtimeId> \
PAPYRUS_SMOKE_TOKEN=replace-with-local-dev-token \
pnpm --filter @papyrus/server run smoke
```

## Remote goose workers

A runtime with `mode: remote` connects the Papyrus server to a supervised goose worker over ACP Streamable HTTP instead of spawning `goose acp` as a child process. Run the worker as a separate process:

```bash
pnpm --filter @papyrus/worker build
pnpm --filter @papyrus/worker start
```

The worker listens for Streamable HTTP ACP connections and relays each connection to a `goose acp` child over stdio. Mutual TLS is enabled by setting `PAPYRUS_WORKER_TLS_CERT`/`KEY`/`CA` (`requestCert` + `rejectUnauthorized`); without TLS the worker refuses a non-loopback listener. `PAPYRUS_WORKER_TOKEN` adds an optional bearer check on top of mTLS.

The server authenticates to the worker with a client certificate (`PAPYRUS_RUNTIME_MTLS_*`) and/or bearer token (`PAPYRUS_RUNTIME_WORKER_TOKEN`). The per-runtime model environment — provider, host, model, and API credential — is sent over this authenticated channel in the `x-papyrus-runtime-config` header, injected into the worker's `goose acp` child environment, and never logged or returned to the browser. The Streamable HTTP transport is still a draft and is pinned behind the `goose-runtime` adapter.

## Offline licensing

`GET /api/license/request` returns the deployment identifier and public identity. A licensing authority signs a document containing that deployment ID, allowed profiles, feature entitlements, issue time, and optional expiry. Papyrus verifies the document against configured P-256 (ECDSA) authority keys without a network call.

License entitlement and Cedar authorization are separate checks. A valid license never grants a user permission.

## Session revocation

OIDC sessions are stateless, signed, time-limited cookies carrying a per-user token version. `POST /api/users/:id/revoke-sessions` (Owner/Admin) increments that version, immediately invalidating every outstanding session for the user. Assigning or changing a role also bumps the version, so a privilege change or demotion invalidates the user's sessions automatically.

## Audit checkpoints

`GET /api/audit/checkpoint` (Owner/Admin/Auditor) returns the full audit chain in sequence order, its integrity status, the deployment identifier, and a P-256 (ECDSA) signature produced with the deployment identity key. The deployment public key is available from `GET /api/license/request`, so an external verifier can confirm a checkpoint without a network call. Export checkpoints to independently controlled storage to obtain tamper evidence outside the host.
