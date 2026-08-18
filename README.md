# Papyrus

Papyrus is a secure, self-hosted ACP gateway for AI agents in regulated and disconnected environments. It fronts arbitrary ACP agents behind authentication, Cedar authorization, audit, and MCP mediation, lets approved clients (Zed, VS Code, or custom) connect through an ACP gateway, and ships an administrative/ops web UI. It does not implement an agent harness of its own.

## What is implemented

- Papyrus administrative/ops web UI (roles, assignments, licenses, audit, health)
- ACP gateway: arbitrary ACP clients (Zed, VS Code, custom) connect to `/acp/<runtimeId>` behind mTLS, Cedar authorization, audit, and MCP mediation
- Commercial OIDC authorization-code flow with PKCE, nonce, issuer, audience, and signature validation
- Government CAC/PIV identity through direct mutually authenticated TLS
- fixed Owner, Admin, User, and Auditor roles
- deny-by-default authorization using the official Cedar 4.12 engine
- workspace and goose runtime assignments
- user-owned sessions with administrative and audit visibility
- workspace-scoped MCP server and tool grants through a session-bound Papyrus proxy
- SQLite-enforced append-only audit rows with a SHA-256 event chain
- goose as the only runtime, using the official stable ACP v1 SDK and `goose acp`
- loopback local mode and durable single-deployment server mode
- P-256 (ECDSA)-signed, deployment-bound offline licensing with rotatable trust-root IDs

The initial product boundary and deferred scope are documented in [docs/product-scope.md](docs/product-scope.md).

## Requirements

- Node.js 24+
- pnpm 11.19
- a pinned goose CLI distribution available to the Papyrus server
- an approved customer model endpoint

## Local development

```bash
pnpm install
pnpm build

export PAPYRUS_MODE=local
export PAPYRUS_DEV_IDENTITY='owner:Local Owner'
export PAPYRUS_BOOTSTRAP_SECRET='replace-me'
export PAPYRUS_LICENSE_REQUIRED=false

pnpm start
```

Open http://127.0.0.1:3210 and enter the one-time bootstrap secret. Development identity is rejected when Papyrus listens on a non-loopback address.

## Production profiles

- `commercial` uses OIDC. TLS may terminate directly in Papyrus or at an approved external boundary.
- `government-il4` and `government-il6` require direct TLS with a trusted client-certificate chain. OIDC is disabled in these profiles.

See [.env.example](.env.example) for configuration and [docs/deployment.md](docs/deployment.md) for deployment behavior.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

This repository is not an authorization to operate, a cross-domain solution, or a claim of IL4/IL6 accreditation.
