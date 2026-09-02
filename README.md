<div align="center">

<img src="assets/papyrus-logo-transparent-v3.png" alt="Papyrus" width="400">

# Papyrus Cyber Twin

**Customer-hosted cyber resilience daemon powered by Starlings.**

</div>

> This is the `experiment/cyber-twin` product-reset branch. The legacy general-agent session harness and Papyrus user directory have been removed.

Papyrus is a licensed daemon for building and operating an evidence-backed cyber terrain twin. Microsoft Teams and Exchange email are human connection adapters. ACP and A2A are machine boundaries. Security data connectors publish typed observations. Starlings is the internal distributed computation substrate.

## Product boundary

```text
Teams / Email / ACP / A2A / Security Connectors
                         │
                         ▼
                  Papyrus daemon
            Entra identity · licensing
           integration policy · audit
                         │
                         ▼
                 Starlings runtime
          observations · claims · conflicts
                         │
                         ▼
                    Cyber twin
```

- **Identity and portal roles:** Microsoft Entra ID application roles. Papyrus has no invitation, password, provisioning, or local role database.
- **Operational safety:** Starlings proposes actions; deterministic workflow policy and an Entra-authorized approver release them.
- **Secrets:** Connector configuration accepts customer-vault, certificate, or managed-identity references. Inline tokens, passwords, client secrets, and private keys are rejected.
- **Licensing:** The existing deployment-bound, signed, offline license format remains. No Beag cloud callback is required.
- **Runtime independence:** Teams and email are adapters. Disabling them does not disable the cyber twin.
- **Sandboxed execution:** Agent code runs only on Linux under Bubblewrap, with network denied. On any other host execution is off, and the daemon reports why rather than falling back to unisolated execution.

## Portal

The web product is now rooted at `/portal` and has no chat/session surface:

- `/portal` — operational posture
- `/portal/terrain` — cyber terrain
- `/portal/investigations` — Starlings claims and investigations
- `/portal/integrations` — operator, evidence, terrain, executor, peer, and infrastructure connectors
- `/portal/governance` — Entra roles, licensing, and action boundary

`/portal/integrations` implements a governed connector lifecycle:

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
export PAPYRUS_DEV_ENTRA_PRINCIPAL='{
  "oid":"local-owner",
  "tenantId":"local-tenant",
  "displayName":"Cyber Operations Owner",
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

## Integration API

Authenticated portal clients use:

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

This branch implements the Entra-native daemon, new portal shell, governed integration lifecycle, offline licensing, audit chain, customer-managed Observation API source profiles, deterministic native-schema normalization, durable observations, database-leased sync workers, provenance-preserving Terrain storage, the Orb 2D Terrain view, and the durable agent foundation: a database-leased signal outbox, read-only investigation tools, a Linux/Bubblewrap sandbox policy, and the LibSQL-backed Mastra bridge.

The Mastra bridge is **wired but not yet live**. `apps/server/src/cyber/mastra/runtime.ts` feature-detects `@mastra/core` and `@mastra/libsql` through dynamic import: with them absent, signals are durably recorded in `cyber_signal_outbox` and the daemon reports that they will drain once the packages are installed. Nothing is silently dropped, and no behavior is claimed by an uninstalled dependency.

The Mastra surface it touches was verified by reading the published `@mastra/core` 1.63.2 type declarations rather than assumed. That check found two real defects, both fixed: `sendSignal` takes two positional arguments (a signal and a `resourceId`/`threadId` target) and returns an `accepted` promise reporting `wake`/`deliver`/`persist`/`discard`/`blocked` — so the runtime now refuses to acknowledge a signal the agent discarded, which would otherwise have silently dropped evidence. And `model` is a required Agent option, so an unconfigured deployment no longer constructs a broken agent; it retains signals until `PAPYRUS_INVESTIGATION_MODEL` is set. Installing `@mastra/core @mastra/libsql` and running a live end-to-end delivery remains the outstanding step.

The Observation API is an advanced custom-ingestion contract, not the primary production collection workflow. Selecting **Connect** registers a source identity and opens a one-record validation/developer bridge that mints a one-hour source-scoped token. Production telemetry should use native SIEM, EDR, OTEL, email, or OT connectors; unattended custom producers require customer-approved workload identity or mTLS plus durable spooling and batching. Waiting custom sources remain in the catalog rather than appearing as operational. Exchange now has a Microsoft Graph delta-polling and send-mail boundary, but customer deployments must supply the approved vault/workload-identity credential resolver before it performs external calls. Live Teams command handling, additional native security connectors, the customer-vault resolver, and the Starlings process adapter remain implementation slices. Pull integrations cannot activate until their driver is registered, and configuration-only tests leave health unknown rather than pretending that saving a connector performed live network validation.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The server test target is the cyber-twin surface. The separate ACP package remains as a machine-interface primitive; it does not provide human chat sessions or a local identity system.

---

Papyrus is not an authorization to operate, a cross-domain solution, or a claim of GCC High, DoD, IL4, IL6, or SIPR accreditation.
