# Deployment guide

## Local mode

Local mode binds to loopback by default, stores its database and deployment identity under the configured data directory, serves the built web UI, and launches `goose acp` as a child process for prompt execution. It is intended for a single workstation or evaluation environment.

The development identity shortcut is explicit and loopback-only. Do not use it to represent an OIDC or CAC deployment.

## Persistent mode

Persistent mode is a long-running, single-deployment service. It requires a session secret of at least 32 characters and requires a valid offline license by default. Configure durable storage, file permissions, backup, log forwarding, process supervision, and TLS before exposing the service.

Persistent mode currently uses SQLite in WAL mode. It is suitable for a controlled single-node deployment, not horizontal multitenant SaaS. A future storage adapter can add a clustered database without changing the domain contracts.

## Commercial OIDC

Configure issuer, client ID, redirect URI, and—when required—the client secret. Papyrus performs discovery, PKCE, state and nonce validation, ID-token signature verification, and issuer/audience checks. Role and resource assignments remain authoritative in Papyrus; identity-provider group claims do not grant access automatically.

## Government CAC/mTLS

Government profiles require direct TLS configuration with a server certificate, private key, and client-certificate trust bundle. The TLS stack rejects clients whose chain is not trusted. Papyrus binds the authenticated certificate fingerprint to a local user record and uses certificate subject data only for display.

Production deployments must supply approved trust anchors and current revocation material at the TLS boundary. This implementation does not claim to perform agency-specific certificate-policy OID mapping, OCSP operations across disconnected networks, or accreditation decisions.

## Goose and models

A runtime record contains only goose plus a customer-approved model endpoint. Model credentials are resolved from server environment variables using the runtime's `secretRef`; they are never returned to the browser. The server starts `goose acp` using stable ACP v1.

Papyrus passes goose only Papyrus proxy URLs for configured MCP servers. The proxy token is bound to the session and server and expires after one hour. Tool discovery is filtered to workspace grants, and tool invocation is authorized and audited before forwarding.

The current MCP proxy supports stateless HTTP JSON-RPC. Stateful Streamable HTTP sessions, SSE, and stdio MCP transports are deliberately unsupported until their session and cancellation semantics can be mediated without bypasses.

## Offline licensing

`GET /api/license/request` returns the deployment identifier and public identity. A licensing authority signs a document containing that deployment ID, allowed profiles, feature entitlements, issue time, and optional expiry. Papyrus verifies the document against configured Ed25519 authority keys without a network call.

License entitlement and Cedar authorization are separate checks. A valid license never grants a user permission.
