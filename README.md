# Papyrus

Papyrus is a secure, self-hosted access and control plane for AI agents in regulated and disconnected environments. It provides the branded web experience and security boundary around goose; it does not implement a second agent harness.

## What is implemented

- Papyrus neobrutalist web UI with individual and administrative activity views
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
- Ed25519-signed, deployment-bound offline licensing with rotatable trust-root IDs

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
