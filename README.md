<div align="center">

<img src="assets/papyrus-logo-transparent-v3.png" alt="Papyrus" width="400">

# Papyrus

**Customer-hosted durable agent runtime powered by Mastra and Starlings.**

</div>

> This is the `experiment/cyber-twin-terrain-runtime` product-reset branch. Entra remains the identity authority; the product surface is now a Mastra-native agent runtime rather than a cyber-twin dashboard.

Papyrus is a licensed daemon for durable, event-driven agent work. Mastra owns sessions, memory, schedules, workflows, and signal delivery. Starlings remains the heterogeneous collective-computation substrate. Teams, Exchange email, ACP, A2A, and customer systems are plugins around that core.

## Product boundary

```text
Teams / Email / ACP / A2A / Customer plugins
                         │
                         ▼
                  Papyrus daemon
            Entra identity · licensing
           plugin policy · action ledger · audit
                         │
                         ▼
                 Starlings runtime
        local operators · claims · conflicts
                         │
                         ▼
        Mastra sessions · signals · workflows
```

- **Identity and portal roles:** Microsoft Entra ID application roles. Papyrus has no invitation, password, provisioning, or local role database.
- **Operational safety:** Starlings proposes actions; deterministic workflow policy and an Entra-authorized approver release them.
- **Secrets:** Connector configuration accepts customer-vault, certificate, or managed-identity references. Inline tokens, passwords, client secrets, and private keys are rejected.
- **Licensing:** The existing deployment-bound, signed, offline license format remains. No Beag cloud callback is required.
- **Runtime independence:** Teams and email are adapters. Disabling them does not disable sessions, workflows, or the Starlings runtime.
- **Sandboxed execution:** Agent code runs only on Linux under Bubblewrap, with network denied. On any other host execution is off, and the daemon reports why rather than falling back to unisolated execution.

## Portal

The web product is rooted at `/portal`:

- `/portal` — durable agent sessions and AI SDK UI tool cards
- `/portal/plugins` — installed plugins and the agent-visible tool catalog
- `/portal/scheduled` — persistent Mastra agent schedules
- `/portal/workflows` — durable, inspectable Mastra workflows
- `/portal/governance` — Entra roles, licensing, and action boundary

Plugin configuration happens inside agent messages. A generated tool exists for every catalog entry and returns a typed secure-configuration card. Credential values are never placed in model context; the card sends credential references directly to the daemon. The governed lifecycle remains:

```text
Draft → Tested → Awaiting Approval → Active → Degraded / Disabled
```

Integration registration, activation, configuration, and disable events form an append-only SHA-256 hash chain.

## Entra application roles

Create these application roles in the customer-owned Entra registration:

| Application role | Authority |
| --- | --- |
| `Papyrus.Integration.View` | View connector configuration and health |
| `Papyrus.Integration.Manage` | Create, test, submit, and disable ordinary connectors |
| `Papyrus.Security.Manage` | Activate high-risk and action-capable connectors |
| `Papyrus.Action.Approve` | Approve individual operational actions |
| `Papyrus.Audit.View` | View append-only connector and decision history |
| `Papyrus.System.Owner` | All portal permissions |

Entra is authoritative. Roles are read from validated token claims and are not copied into a Papyrus role table.

## Local development

Node.js 24 and pnpm 11 are required. macOS and Windows are fine for development — the daemon, portal, connectors, and action ledger all run there. Agent code execution does not: it is Linux-only and enforced with Bubblewrap, and it turns itself off with an explicit log line anywhere else. See [docs/deployment.md](docs/deployment.md#platform-requirements).

```bash
pnpm install --frozen-lockfile
pnpm build

export PAPYRUS_MODE=local
export PAPYRUS_PROFILE=gcc
export PAPYRUS_HOST=127.0.0.1
export PAPYRUS_PORT=3210
export PAPYRUS_PUBLIC_ORIGIN=http://127.0.0.1:3210
export PAPYRUS_PORTAL_SECRET="$(openssl rand -hex 32)"
export PAPYRUS_LICENSE_REQUIRED=false
export PAPYRUS_DATABASE_PATH=:memory:
export PAPYRUS_AGENT_MODEL='openai/gpt-5' # any Mastra model id the deployment can reach
export PAPYRUS_DEV_ENTRA_PRINCIPAL='{
  "oid":"local-owner",
  "tenantId":"local-tenant",
  "displayName":"Operations Owner",
  "preferredUsername":"owner@example.mil",
  "roles":["Papyrus.System.Owner"],
  "groups":[]
}'

pnpm start
```

`PAPYRUS_DEV_ENTRA_PRINCIPAL` is accepted only in local mode. Persistent mode requires a real Entra tenant and application registration.

## Persistent Entra configuration

```bash
export PAPYRUS_MODE=persistent
export PAPYRUS_PROFILE=gcch             # gcc | gcch | dod | restricted | disconnected
export PAPYRUS_PUBLIC_ORIGIN=https://papyrus.customer.example
export PAPYRUS_PORTAL_SECRET="..."
export PAPYRUS_ENTRA_TENANT_ID="..."
export PAPYRUS_ENTRA_CLIENT_ID="..."
export PAPYRUS_ENTRA_CLIENT_SECRET="..." # omit when the selected deployment identity does not require it
export PAPYRUS_ENTRA_SCOPE="api://<client-id>/access_as_user"
export PAPYRUS_ENTRA_CLOUD=USGov         # Public | USGov | USGovDoD
export PAPYRUS_TLS_CERT=/run/papyrus/tls/server.pem
export PAPYRUS_TLS_KEY=/run/papyrus/tls/server-key.pem
export PAPYRUS_LICENSE_AUTHORITIES='{ "beag-root": "-----BEGIN PUBLIC KEY-----..." }'
```

Cloud defaults are inferred from the deployment profile, but an explicit value is recommended in production.

## Runtime API

Authenticated portal clients use:

- `GET|POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/agent/chat` — AI SDK UI v7 stream
- `GET /api/plugins`
- `POST /api/plugins/connect`
- `GET|POST /api/schedules`
- `GET /api/workflows`
- `POST /api/workflows/:id/runs`
- `POST /api/signals/:sourceId/webhook` — source-scoped token required

- `GET /api/integrations/catalog`
- `GET /api/integrations`
- `POST /api/integrations`
- `POST /api/integrations/:id/test`
- `POST /api/integrations/:id/submit`
- `POST /api/integrations/:id/activate`
- `POST /api/integrations/:id/disable`
- `GET /api/integrations/:id/events`
- `POST /api/integrations/:id/observations`
- `POST /api/integrations/:id/sync`
- `GET /api/integrations/:id/sync-jobs`
- `GET /api/terrain`

Teams SSO tokens can be exchanged at `POST /api/auth/teams`; standard portal login uses Entra authorization code + PKCE through `/api/auth/entra/login`.

## Current experiment boundary

This branch implements the Entra-native daemon, offline licensing, governed plugin lifecycle, action ledger and leased executor worker, Mastra LibSQL memory, durable evented agent registration, session history, native schedules, a signal-intake workflow, WebhookSignalProvider delivery backed by a database-leased outbox, agent-rendered plugin configuration cards, and guarded URL previews.

Mastra is now a server dependency. Its storage starts even when no model is configured, so session and workflow state remain available. When `PAPYRUS_AGENT_MODEL` is absent, the daemon refuses chat and keeps incoming signals in `cyber_signal_outbox`; it does not invent a default provider or discard events.

`fetchUrlPreview` permits HTTPS by default, follows redirects only after re-validation, limits response size, and rejects credentials, loopback, link-local, metadata, private, and reserved destinations. Reviewed internal hosts can be enumerated with `PAPYRUS_FETCH_ALLOWED_HOSTS`.

The Observation API is an advanced custom-ingestion contract, not the primary production collection workflow. Selecting **Connect** registers a source identity and opens a one-record validation/developer bridge that mints a one-hour source-scoped token. Production telemetry should use native SIEM, EDR, OTEL, email, or OT connectors; unattended custom producers require customer-approved workload identity or mTLS plus durable spooling and batching. Waiting custom sources remain in the catalog rather than appearing as operational. Exchange now has a Microsoft Graph delta-polling and send-mail boundary, but customer deployments must supply the approved vault/workload-identity credential resolver before it performs external calls. Live Teams command handling, additional native security connectors, the customer-vault resolver, and the Starlings process adapter remain implementation slices. Pull integrations cannot activate until their driver is registered, and configuration-only tests leave health unknown rather than pretending that saving a connector performed live network validation.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The separate ACP package remains a machine-interface primitive; it does not provide a local identity system.

---

Papyrus is not an authorization to operate, a cross-domain solution, or a claim of GCC High, DoD, IL4, IL6, or SIPR accreditation.
