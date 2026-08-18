# Security model and current limitations

## Enforced invariants

- protected application operations are evaluated by the embedded, versioned Cedar policy bundle;
- authorization is deny-by-default;
- Owner bootstrap requires an installation secret and can succeed only once;
- Admins cannot assign Owner or Admin roles;
- session creation requires assignment to both the workspace and goose runtime;
- Users can prompt only sessions they own;
- goose receives only workspace-authorized MCP proxy endpoints;
- audit rows cannot be updated or deleted through SQLite because database triggers reject both operations;
- audit events are hash-chained over a canonical envelope; and
- model credentials stay in the server process environment.

## Honest limitations

- A database administrator can replace the database. Signed audit checkpoints (`GET /api/audit/checkpoint`) provide exportable tamper evidence, but independently controlled immutable storage is still the operator's responsibility.
- CAC trust and revocation quality depend on deployment-provided trust bundles and boundary operations.
- OIDC login sessions are signed, time-limited, and server-side revocable: role changes and explicit revocation bump a per-user token version, immediately invalidating outstanding sessions.
- The goose adapter starts a fresh ACP process for a prompt turn. Durable ACP conversation resume depends on goose session lifecycle support and is not represented as complete.
- The MCP proxy supports stateless HTTP JSON-RPC only.
- The UI exposes the implemented administration surfaces but does not yet cover every assignment and MCP configuration operation; those operations are available through the API.
- No part of Papyrus constitutes a cross-domain solution or an authorization to operate.
