<div align="center">

<img src="assets/papyrus-logo-transparent-v3.png" alt="Papyrus" width="400">

# Papyrus

**Secure, self-hosted ACP daemon for regulated and disconnected environments.**

[![FOSSA Status](https://app.fossa.com/api/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus.svg?type=shield&issueType=license)](https://app.fossa.com/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus?ref=badge_shield&issueType=license)
[![FOSSA Status](https://app.fossa.com/api/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus.svg?type=shield&issueType=security)](https://app.fossa.com/projects/custom%2B63623%2Fgithub.com%2Fbeaglabs%2Fpapyrus?ref=badge_shield&issueType=security)

</div>

---

Papyrus is an ACP access and control daemon. It places authentication, Cedar authorization, session ownership, audit, and MCP mediation between approved agent clients and supervised ACP runtimes.

Papyrus is not an agent harness and does not provide a chat or browser-session UI. Clients such as Zed, Chrome ACP, or a customer application remain responsible for user interaction. The existing web assets are limited to administrative and operational functions.

## Current capabilities

- **ACP gateway** — approved clients connect to `/acp/<runtimeId>`
- **Authentication** — commercial OIDC with PKCE and government CAC/PIV through mTLS
- **Authorization** — deny-by-default Cedar policy with fixed Owner, Admin, User, and Auditor roles
- **Audit** — append-only SQLite events with a SHA-256 hash chain
- **Sessions** — user-owned runtime sessions with administrative and audit visibility
- **MCP mediation** — environment-scoped server and tool grants through a session-bound proxy
- **Offline licensing** — deployment-bound signed licenses required in persistent mode
- **Runtime adapter** — the current implementation uses Goose behind a replaceable ACP boundary

Papyrus does not embed a browser engine or expose native browser tools. Browser and legacy web automation are supplied by an administrator-approved MCP server, assigned to an environment, and mediated through the existing Cedar browser actions. A separate reference `papyrus-browser-mcp` based on Lightpanda is planned; it is not part of the core daemon.

The active daemon-first migration plan is documented in [ACP daemon stack](docs/acp-daemon-stack.md). Runtime-neutral core interfaces, local stdio supervision, remote Streamable HTTP, external client bridging, adapter profiles, and the hardened FIPS image land as separate stacked pull requests.

## Requirements

- Node.js 24+
- pnpm 11.22.0
- A configured ACP runtime; Goose remains the current adapter until the runtime-neutral layer lands
- An approved customer model endpoint

## Local development (commercial profile)

```bash
pnpm install --frozen-lockfile
pnpm build

export PAPYRUS_MODE=local
export PAPYRUS_PROFILE=commercial
export PAPYRUS_DEV_IDENTITY='owner:Local Owner'
export PAPYRUS_BOOTSTRAP_SECRET='replace-with-single-use-bootstrap-secret'
export PAPYRUS_SESSION_SECRET="$(openssl rand -hex 32)"
export PAPYRUS_LICENSE_REQUIRED=false

# Model endpoint (required for agent sessions)
export PAPYRUS_MODEL_ENDPOINT=https://openrouter.ai/api
export PAPYRUS_MODEL=liquid/lfm-2.5-2.6b:free
export PAPYRUS_MODEL_API_KEY=your-openrouter-key

# Optional: ACP gateway for Goose/ACP clients
export PAPYRUS_GATEWAY_ENABLED=true
export PAPYRUS_GATEWAY_DEV_TOKEN="$(openssl rand -hex 32)"

pnpm start
```

The API listens on `http://127.0.0.1:3210`; the ACP gateway listens on `127.0.0.1:3220`. Do not set `GOOSE_SERVER__SECRET_KEY`; it belongs to the Goose runtime process.

## Local development (government profile with mTLS)

```bash
pnpm install --frozen-lockfile
pnpm build

# Generate test certificates (one-time)
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/cac-ca-key.pem -out certs/cac-ca.pem -days 365 -nodes -subj "/CN=Test CAC CA"
openssl req -newkey rsa:4096 -keyout certs/server-key.pem -out certs/server.csr -nodes -subj "/CN=papyrus.local"
openssl x509 -req -in certs/server.csr -CA certs/cac-ca.pem -CAkey certs/cac-ca-key.pem -CAcreateserial -out certs/server.pem -days 365 -sha256
openssl req -newkey rsa:4096 -keyout certs/client-key.pem -out certs/client.csr -nodes -subj "/CN=Test User/emailAddress=user@test.local"
openssl x509 -req -in certs/client.csr -CA certs/cac-ca.pem -CAkey certs/cac-ca-key.pem -CAcreateserial -out certs/client.pem -days 365 -sha256
openssl pkcs12 -export -in certs/client.pem -inkey certs/client-key.pem -out certs/client.p12 -name "Test CAC User" -passout pass:test123

export PAPYRUS_MODE=local
export PAPYRUS_PROFILE=government-il4
export PAPYRUS_HOST=127.0.0.1
export PAPYRUS_PORT=3210
export PAPYRUS_PUBLIC_ORIGIN=https://127.0.0.1:3210
export PAPYRUS_TLS_CERT=/Users/jdbohrman/papyrus/certs/server.pem
export PAPYRUS_TLS_KEY=/Users/jdbohrman/papyrus/certs/server-key.pem
export PAPYRUS_TLS_CA=/Users/jdbohrman/papyrus/certs/cac-ca.pem
export PAPYRUS_SESSION_SECRET="$(openssl rand -hex 32)"
export PAPYRUS_BOOTSTRAP_SECRET="$(openssl rand -hex 32)"
export PAPYRUS_LICENSE_REQUIRED=false

# Model endpoint
export PAPYRUS_MODEL_ENDPOINT=https://openrouter.ai/api
export PAPYRUS_MODEL=liquid/lfm-2.5-2.6b:free
export PAPYRUS_MODEL_API_KEY=your-openrouter-key

# Optional: sandbox runtime for code execution
# export PAPYRUS_SANDBOX_API_KEY=... (not required for local sandbox-runtime)

pnpm start
```

Import `certs/client.p12` into your browser (password: `test123`), then visit `https://127.0.0.1:3210` and select the certificate when prompted.

## Production profiles

| Profile | Authentication | Transport boundary |
| --- | --- | --- |
| `commercial` | OIDC authorization-code flow with PKCE | Direct TLS or an approved HTTPS boundary |
| `government-il4` | CAC/PIV certificate identity | Direct mutual TLS |
| `government-il6` | CAC/PIV certificate identity | Direct mutual TLS |

Profile names are deployment baselines, not accreditation or authorization claims.

### Required production environment variables

**Commercial:**
- `PAPYRUS_OIDC_ISSUER`, `PAPYRUS_OIDC_CLIENT_ID`, `PAPYRUS_OIDC_REDIRECT_URI`
- `PAPYRUS_SESSION_SECRET` (32+ random chars)
- `PAPYRUS_BOOTSTRAP_SECRET` (single-use)
- `PAPYRUS_MODEL_ENDPOINT`, `PAPYRUS_MODEL`, `PAPYRUS_MODEL_API_KEY`

**Government:**
- `PAPYRUS_TLS_CERT`, `PAPYRUS_TLS_KEY`, `PAPYRUS_TLS_CA` (CAC/PIV trust bundle)
- `PAPYRUS_TLS_CRL` (optional revocation list)
- `PAPYRUS_SESSION_SECRET`, `PAPYRUS_BOOTSTRAP_SECRET`
- `PAPYRUS_MODEL_ENDPOINT`, `PAPYRUS_MODEL`, `PAPYRUS_MODEL_API_KEY`
- Node.js 24+ with `--enable-fips` (FIPS-validated OpenSSL required)

Local mode does not require a production license. Persistent mode always requires a valid signed license and has no environment-variable bypass.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Documentation

- [ACP daemon stack](docs/acp-daemon-stack.md) — branch order, boundaries, and acceptance gates
- [Product scope](docs/product-scope.md) — daemon-first product decision
- [Deployment](docs/deployment.md) — deployment modes and requirements
- [Security](docs/security.md) — security model and limitations
- [Operations](docs/operations.md) — backup, recovery, and supervision runbooks

---

*This repository is not an authorization to operate, a cross-domain solution, or a claim of IL4/IL6 accreditation.*
