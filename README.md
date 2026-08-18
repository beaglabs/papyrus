<div align="center">

<img src="assets/papyrus-logo-transparent-v3.png" alt="Papyrus" width="400">

# Papyrus

**Secure, self-hosted ACP gateway for AI agents in regulated and disconnected environments.**

[![FOSSA Status](https://app.fossa.com/api/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus.svg?type=shield&issueType=license)](https://app.fossa.com/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus?ref=badge_shield&issueType=license)
[![FOSSA Status](https://app.fossa.com/api/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus.svg?type=shield&issueType=security)](https://app.fossa.com/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus?ref=badge_shield&issueType=security)

</div>

---

Papyrus fronts arbitrary ACP agents behind authentication, Cedar authorization, audit, and MCP mediation. Approved clients (Zed, VS Code, or custom) connect through an ACP gateway. It ships an administrative/ops web UI and does not implement an agent harness of its own.

## Features

- **ACP Gateway** — arbitrary ACP clients connect to `/acp/<runtimeId>` behind mTLS, Cedar authorization, audit, and MCP mediation
- **Authentication** — commercial OIDC authorization-code flow with PKCE; government CAC/PIV via mTLS
- **Authorization** — deny-by-default using Cedar 4.12 with fixed Owner, Admin, User, and Auditor roles
- **Audit** — SQLite-enforced append-only rows with a SHA-256 event chain
- **Sessions** — user-owned sessions with administrative and audit visibility
- **MCP Mediation** — workspace-scoped MCP server and tool grants through a session-bound proxy
- **Licensing** — P-256 (ECDSA)-signed, deployment-bound offline licensing with rotatable trust-root IDs
- **Web UI** — administrative dashboard for roles, assignments, licenses, audit, and health
- **Runtime** — goose as the only runtime, using the official stable ACP v1 SDK

## Requirements

- Node.js 24+
- pnpm 11.19
- A pinned goose CLI distribution available to the Papyrus server
- An approved customer model endpoint

## Quick Start

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

## Production Profiles

| Profile | Auth | TLS |
|---------|------|-----|
| `commercial` | OIDC | May terminate in Papyrus or at external boundary |
| `government-il4` | mTLS (CAC/PIV) | Direct TLS with trusted client-certificate chain |
| `government-il6` | mTLS (CAC/PIV) | Direct TLS with trusted client-certificate chain |

See [.env.example](.env.example) for configuration and [docs/deployment.md](docs/deployment.md) for deployment behavior.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Documentation

- [Product Scope](docs/product-scope.md) — initial product boundary and deferred scope
- [Deployment](docs/deployment.md) — deployment modes and requirements
- [Security](docs/security.md) — security model and limitations
- [Operations](docs/operations.md) — backup, recovery, and supervision runbooks

---

*This repository is not an authorization to operate, a cross-domain solution, or a claim of IL4/IL6 accreditation.*
