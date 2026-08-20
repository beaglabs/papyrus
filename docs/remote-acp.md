# Remote ACP daemon transport

Papyrus exposes the official ACP Streamable HTTP transport at `POST`, `GET`,
and `DELETE /acp`. WebSocket upgrades are intentionally rejected. Native and
service clients should use `createHttpStream` from `@agentclientprotocol/sdk`.

## Authentication and workspace binding

Every request, including requests made after `initialize`, is authenticated by
the daemon. Commercial clients use a revocable Papyrus bearer session obtained
through the native OIDC handoff. Government clients authenticate on the
CA-validated mTLS connection. The loopback-only development token remains
available for local testing.

Set `X-Papyrus-Workspace-Id` on initialization when the principal can access
more than one workspace. Papyrus binds the returned `Acp-Connection-Id` to both
the authenticated principal and selected workspace. A different principal or
workspace cannot reuse that connection identifier.

Credentials belong in `Authorization` or the authenticated TLS channel. They
must never be placed in a URL. Papyrus does not enable browser CORS on `/acp`.

## Deployment controls

The remote listener requires mTLS whenever it binds beyond loopback. Configure
the following environment variables:

- `PAPYRUS_GATEWAY_ENABLED=true`
- `PAPYRUS_GATEWAY_HOST` and `PAPYRUS_GATEWAY_PORT`
- `PAPYRUS_GATEWAY_TLS_CERT`, `PAPYRUS_GATEWAY_TLS_KEY`, and
  `PAPYRUS_GATEWAY_TLS_CA` for non-loopback listeners
- `PAPYRUS_GATEWAY_MAX_REQUEST_BODY_BYTES` (default 1 MiB)
- `PAPYRUS_GATEWAY_MAX_CONNECTIONS` (default 128 ACP connections)
- `PAPYRUS_GATEWAY_CONNECTION_IDLE_MS` (default 15 minutes)
- `PAPYRUS_GATEWAY_REQUEST_TIMEOUT_MS` (default 30 seconds to receive a request)

The body limit is enforced for declared and chunked request bodies. Idle
connections are deleted from the ACP server, while active SSE subscriptions are
not expired. Logical connection limits are separate from TCP socket limits so
Streamable HTTP can use its request and event-stream channels correctly.
