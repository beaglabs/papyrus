<div align="center">

<img src="assets/papyrus-logo-transparent-v3.png" alt="Papyrus" width="400">

# Papyrus

**Customer-hosted durable agent runtime powered by Mastra and Starlings.**

[![CDAO Tradewinds — Awardable][badge-tsm]][link-tsm]
[![Status: Experimental][badge-status]][link-status] ![Version 0.1.0][badge-version] ![License: Proprietary][badge-license]
[![Node >= 24][badge-node]][link-node] [![pnpm 11.22][badge-pnpm]][link-pnpm] ![Built with TypeScript][badge-ts]

<br>

<a href="https://www.tradewindai.com/tw-marketplace"><img src="assets/tradewinds-awardable-badge.png" alt="Tradewinds Solutions Marketplace — Awardable" width="132"></a>

_Deemed **Awardable** on the DoW CDAO [Tradewinds Solutions Marketplace](https://www.tradewindai.com/tw-marketplace)._

</div>

> [!NOTE]
> This is the `experiment/agent-twin-terrain-runtime` product-reset branch. Entra remains the identity authority; the product surface is now a Mastra-native agent runtime rather than an agent-twin dashboard.

Papyrus is a licensed daemon for durable, event-driven agent work. Mastra owns sessions, memory, schedules, workflows, and signal delivery. Starlings remains the heterogeneous collective-computation substrate. Teams, Exchange email, ACP, A2A, and customer systems are plugins around that core.

## Contents

- [Overview](#overview)
- [Product boundary](#product-boundary)
- [Portal](#portal)
- [Entra application roles](#entra-application-roles)
- [Local development](#local-development)
- [Persistent Entra configuration](#persistent-entra-configuration)
- [Runtime API](#runtime-api)
- [Project status](#project-status)
- [Verification](#verification)
- [Related repositories](#related-repositories)

## Overview

| | |
| --- | --- |
| **Identity and portal roles** | Microsoft Entra ID application roles. Papyrus has no invitation, password, provisioning, or local role database. |
| **Operational safety** | Starlings proposes actions; deterministic workflow policy and an Entra-authorized approver release them. |
| **Secrets** | Connector configuration accepts customer-vault, certificate, or managed-identity references. Inline tokens, passwords, client secrets, and private keys are rejected. |
| **Licensing** | The existing deployment-bound, signed, offline license format remains. No Beag cloud callback is required. |
| **Runtime independence** | Teams and email are adapters. Disabling them does not disable sessions, workflows, or the Starlings runtime. |
| **Sandboxed execution** | Agent code runs only on Linux under Bubblewrap, with network denied. On any other host execution is off, and the daemon reports why rather than falling back to unisolated execution. |

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

## Portal

The web product is rooted at `/portal`:

| Route | Purpose |
| --- | --- |
| `/portal` | Durable agent sessions and AI SDK UI tool cards |
| `/portal/models` | Customer model gateways and the agent-guided model configuration form |
| `/portal/plugins` | Installed plugins and the agent-visible tool catalog |
| `/portal/scheduled` | Persistent Mastra agent schedules |
| `/portal/workflows` | Durable, inspectable Mastra workflows |
| `/portal/governance` | Entra roles, licensing, and action boundary |

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
# Optional one-time bootstrap; durable profiles can be configured at /portal/models.
export PAPYRUS_AGENT_MODEL='openai/gpt-5'
export PAPYRUS_MODEL_BASE_URL='https://api.openai.com/v1'
export PAPYRUS_MODEL_CREDENTIAL_REF='env://OPENAI_API_KEY'
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

**Sessions and agent**

- `GET|POST /api/sessions`
- `GET /api/sessions/:id/messages`
- `POST /api/agent/chat` — AI SDK UI v7 stream

**Model profiles**

- `GET|POST /api/model-profiles`
- `POST|DELETE /api/model-profiles/:id` — test, select, disable, or remove a durable model profile

**Plugins, schedules, workflows, and signals**

- `GET /api/plugins`
- `POST /api/plugins/connect`
- `GET|POST /api/schedules`
- `GET /api/workflows`
- `POST /api/workflows/:id/runs`
- `POST /api/signals/:sourceId/webhook` — source-scoped token required

**Integrations**

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

## Project status

> [!IMPORTANT]
> Papyrus was deemed **Awardable** on the DoW CDAO [Tradewinds Solutions Marketplace](https://www.tradewindai.com/tw-marketplace) — a post-competition status that lets DoW organizations view, select, and award the solution without running a fresh competition.

This branch implements the Entra-native daemon, offline licensing, governed plugin lifecycle, action ledger and leased executor worker, Mastra LibSQL memory, durable evented agent registration, session history, native schedules, a signal-intake workflow, WebhookSignalProvider delivery backed by a database-leased outbox, agent-rendered plugin configuration cards, and guarded URL previews.

Mastra is now a server dependency. Its storage starts even when no model is configured, so session and workflow state remain available. When `PAPYRUS_AGENT_MODEL` is absent, the daemon refuses chat and keeps incoming signals in `agent_signal_outbox`; it does not invent a default provider or discard events.

`fetchUrlPreview` permits HTTPS by default, follows redirects only after re-validation, limits response size, and rejects credentials, loopback, link-local, metadata, private, and reserved destinations. Reviewed internal hosts can be enumerated with `PAPYRUS_FETCH_ALLOWED_HOSTS`.

The Observation API is an advanced custom-ingestion contract, not the primary production collection workflow. Selecting **Connect** registers a source identity and opens a one-record validation/developer bridge that mints a one-hour source-scoped token. Production telemetry should use native SIEM, EDR, OTEL, email, or OT connectors; unattended custom producers require customer-approved workload identity or mTLS plus durable spooling and batching. Waiting custom sources remain in the catalog rather than appearing as operational. Exchange now has a Microsoft Graph delta-polling and send-mail boundary, but customer deployments must supply the approved vault/workload-identity credential resolver before it performs external calls. Live Teams command handling, additional native security connectors, the customer-vault resolver, and the Starlings process adapter remain implementation slices. Pull integrations cannot activate until their driver is registered, and configuration-only tests leave health unknown rather than pretending that saving a connector performed live network validation.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The separate ACP package remains a machine-interface primitive; it does not provide a local identity system.

## Related repositories

- [`beaglabs/papyrus-extensions`](https://github.com/beaglabs/papyrus-extensions) — the extension SDK (`papyrus-extension-sdk`) and the first domain pack, `papyrus-gnss` (TLE / OMM / SP3 / NMEA / SINEX parsers and viewer cards). Extensions add **read-only** agent tools and their UI cards through a stable, authority-limited contract without modifying the hardened core.

---

> [!IMPORTANT]
> Papyrus is not an authorization to operate, a cross-domain solution, or a claim of GCC High, DoD, IL4, IL6, or SIPR accreditation.

<!-- Badge definitions -->
[badge-tsm]: https://img.shields.io/badge/CDAO%20Tradewinds-Awardable-000000?labelColor=000000&color=000000&logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM%2FrhtAAAGPklEQVR42u1Yz28TSRb%2Bqrq6Xe623W07MZigBJPIhCAlE4EiIaQFIY1GXHJYyOwl%2F8BcdvYPGCVaabntYfc0f8MM0iarnGDYw%2BbEDQ5DmCDyA8IY7Hbijh3bbbu73h5iImbZGUKy0bCrfFLdXtd79b33qr7XwDGOcYz%2FbbAj3Is%2BhgNyAGJqakrjnOPtNTU1pQEQXZtfhXmNsZ%2BQJgA43SX2DHdttINm6yAfccaYIiIAOO04zm9t2%2F7UMIxhAA7nHETkhWH4w%2Bbm5nee5%2F0NwEvGGIiIA1BHGaDGGAuJyMxkMl9lMpkvTNN0DMMAEUEphTAMAQC%2B70NKiWaz6RWLxa9LpdKfGGMNItIAhEcR4Bvm8sPDw9%2FYtv0J5xyNRiNwHIcVCgXm%2Bz4TQsA0TfJ9n86cOUPb29uCMYZqtfpoeXn5d4yxpx%2FCJPvA4IZGRkb%2BqZQ6ZVlWR0opVldXWalUQhiGEGK39IIgQCQSQTqdRm9vL%2Fm%2BH0SjUb3VahWePHlylTH2bL9B7qfD2OzsLIjIzOVyc7FY7FQsFgvW19d13%2FfZtWvXYNs28vk8pqenMT09jXw%2BD8uycPXqVRiGwdrttp5KpYJoNHoql8vNEZE5Ozu7L4K0%2FdTd4uKiSiaTf%2Bzr67vJGOu8fv1aHxkZQSaTwdzcHNLpNG7dugUigq7rGB0dxdOnT%2FHgwQNcunQJhmGgUCjwdDrdEUJkm80mu3v37j%2B6%2FukwDDLOeUhE2Uwm83vDMFSr1RKJRAKWZWF%2Bfh5hGEJKudcgYRhCKQUpJcIwxPz8PGzbhpQSruuKRqOhstnsl0SU5ZyH72PxfQFqSinE4%2FHPLcuyPM9T5XKZjY%2BPY2FhAZqmQUqJiYkJ%2BL6PIAgQBAF838fExASklNA0DQsLCxgbG4PnecyyLCWltOLx%2BOdKqfdm8RcDnJqaIgBwHOczwzBISslqtRru378PzjkYY9B1HVJKMMbgeR4qlQoYY5BSQtf1Pbt79%2B6h2WxCKcU455RMJj9728dBuphxzkkpJc6ePbuczWbPNhoN9fDhw3cOFY%2FHkcvlUCwWoes6UqkU1tbWUKvV3tl0ZGREJRIJ7rru6srKyjnOeaCUYj9Xi2IfTRKLRCJ2tVpFoVBgV65cwZuLudFoIJVKYWdnB9lsFv39%2FXBdF5xzjI%2BPo7e3F5FIBHNzc7h%2B%2FTparRaWlpYY5xyGYdgAYgC8X3Iu9vV8aBo2NzfRbDYxOjoKx3EQBAG6zxeUUtjZ2UE8HkdPTw%2F6%2BvrQbrdhWRZM04TneRgbG8PGxgYWFxchhEAikTi8IOCcA4AYGBhYmZycpMHBwRAACSEIAHHOCQAxxggAGYZB3VQRAIpEIgSAbNsm0zQpGo3S4OBgODk5SQMDAysARNcHOwiDdPPmTe3OnTuBUmq5XC7nqtUq3bhxA9lsFuVyGf%2BmZlAqlbCzs4NcLgfGGMIwhKZp6HQ6OHHiBAqFAh49ekSu65JSahlA0PURHvSpEwACy7K%2BvHDhwl%2Fa7Xbguq4QQqBWq%2B11KAAQEcrlMk6ePLknGDjne%2FejZVkgIjiOE5imKR4%2FfvyHer3%2B1zc%2BDlqDIecc9Xr92%2B3t7dvpdDqqlCLLstjw8DA6nQ5839%2BrU13Xsba2hr6%2BPmxtbe3VWjKZxOrqKpaWlojv5rRer9e%2F7R4gPNRTR0QaY6wahqGVTCZ%2F4zhOsLm5qW1sbGB7exunT5%2BGEAJSSnQ6Hdi2jTAMkUgkoJTC8vIyNjY2wBjD0NBQEI%2FHxfr6%2Bp9brdbfu9JLHVYsqJmZGV6pVG4Xi8XvNU3TLcsKXNfFy5cv8erVKxSLRRQKBRQKBbx48QKu66JcLmNrawuVSgVBECCdTgdCCL1UKn1fqVRuz8zMfLB4fZ%2FcAoCh8%2BfP%2Fzg2Nkamabb7%2B%2FvV2137n5ZhGOrixYvty5cvUz6f%2FxHAUHcv%2Ft%2FUgz8RrOfOnfump6fnE8YYtra2gmfPnrGenh7WbDYZAEgpKZlMkud51L2mUCqVHq2srByZYH1H8qfT6a%2By2ewXlmU5QRAgFoshCHabUdf13Q4LQzQaDe%2F58%2Bdfl8vlI5f8Pzs0pVKpTzVNG%2B5OdCAir9Vq%2FeB53ne1Wu1QQ9NHP3Z%2B9IP7%2F%2F2vj2Mc4xi%2FNv4FUZf2BB32r9gAAAAASUVORK5CYII%3D
[badge-status]: https://img.shields.io/badge/status-experimental-orange
[badge-version]: https://img.shields.io/badge/version-0.1.0-blue
[badge-node]: https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white
[badge-pnpm]: https://img.shields.io/badge/pnpm-11.22-F69220?logo=pnpm&logoColor=white
[badge-ts]: https://img.shields.io/badge/built%20with-TypeScript-3178C6?logo=typescript&logoColor=white
[badge-license]: https://img.shields.io/badge/license-Proprietary-lightgrey
[link-tsm]: https://www.tradewindai.com/tw-marketplace
[link-status]: #project-status
[link-node]: #local-development
[link-pnpm]: #local-development
