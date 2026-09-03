# Papyrus daemon deployment

Papyrus runs as a customer-hosted, single-deployment daemon. Teams, Exchange, ACP, A2A peers, and security products connect to the daemon; none is required for the runtime to remain available.

## Identity boundary

Persistent deployments require one customer-owned Microsoft Entra application registration. Configure application roles from the root README and assign them in Entra. Papyrus validates Microsoft-issued tokens and derives a one-hour, HTTP-only portal cookie from those claims. It does not create a user, invitation, password, group, or local role record.

Use the Entra cloud matching the tenant:

| Profile | Typical Entra cloud |
| --- | --- |
| Commercial, GCC | `Public` |
| GCC High, IL4 | `USGov` |
| DoD, IL6 | `USGovDoD` |

The mapping is a deployment default, not an accreditation claim. The operator remains responsible for selecting the correct national-cloud endpoints and approving application deployment.

## Platform requirements

Papyrus runs anywhere Node.js runs, but **agent code execution is Linux-only**. Deploy on Linux with Bubblewrap (`bwrap`) installed.

| Host | Papyrus daemon | Agent code execution |
| --- | --- | --- |
| Linux + `bwrap` on PATH | Supported | **Supported** (Bubblewrap isolation, network denied) |
| Linux without `bwrap` | Supported | **Disabled** — refuses to run code unisolated |
| macOS | Supported | **Disabled** — unsupported, not degraded |
| Windows | Supported | **Disabled** — unsupported, not degraded |

The sandbox never falls back to running unisolated. If Bubblewrap is missing, or the host is not Linux, execution stays off and the daemon logs the specific reason at startup. Everything that does not execute agent code — Entra identity, connectors, observations, terrain, the action ledger, and the portal — works identically on every platform.

macOS is excluded deliberately rather than for lack of effort: its only native mechanism is Seatbelt (`sandbox-exec`), which Apple has deprecated. Shipping it would advertise an isolation guarantee we could not stand behind.

Development on macOS is fine and expected. It simply runs with execution disabled, and says so instead of quietly pretending otherwise.

```bash
# Debian / Ubuntu
sudo apt-get install bubblewrap
# RHEL / Fedora / Rocky
sudo dnf install bubblewrap

bwrap --version   # verify it is on PATH before starting Papyrus
```

Papyrus resolves execution policy at startup from `process.platform` and a PATH lookup. There is no configuration flag to force the sandbox on — the only supported inputs are the platform and the presence of `bwrap`.

## Agent configuration

The agent needs a model, and choosing one is the customer's decision — `disconnected` and `restricted` profiles cannot reach a hosted provider at all. Papyrus will not guess a default.

```bash
# Optional one-time bootstrap; durable profiles can be configured at /portal/models.
export PAPYRUS_AGENT_MODEL='openai/gpt-5'
export PAPYRUS_MODEL_BASE_URL='https://api.openai.com/v1'
export PAPYRUS_MODEL_CREDENTIAL_REF='env://OPENAI_API_KEY'
```

Without it the agent is not registered. Mastra storage, session history, workflows, and plugin configuration still start normally, while signals accumulate durably in `cyber_signal_outbox`. Nothing is dropped while unconfigured. The Models tab stores only gateway metadata and a customer-owned credential reference; it never stores raw key material.

Storage for durable threads is LibSQL at `<data-dir>/mastra.db`, created alongside the main database.

The Mastra API surface this depends on, and the version it was verified against, is recorded in [mastra-integration.md](mastra-integration.md). Check it before upgrading Mastra.

## Runtime modes

- `local`: loopback evaluation. It may use `PAPYRUS_DEV_ENTRA_PRINCIPAL`.
- `persistent`: durable customer deployment. It requires real Entra configuration, TLS, a portal signing secret, durable storage, and normally a signed offline license. On Linux with Bubblewrap present it also enables sandboxed agent code execution.

Persistent mode uses SQLite in WAL mode and is intended for a supervised single-node deployment. Back up the database and connector configuration, store keys and connector credentials in customer-controlled secret infrastructure, and export audit events to independently controlled storage.

## Interface availability

Teams is an adapter, not a runtime dependency. GCC High and DoD application deployment must follow the customer's approved national-cloud process. Email and the authenticated portal can operate without Teams. Disconnected deployments can omit Microsoft adapters and use locally reachable portal, ACP, A2A, and security connectors.

## Licensing

`GET /api/license/request` returns the deployment identity. A licensing authority signs a license containing that deployment ID, profiles, features, issue time, and optional expiry. Papyrus verifies the signature locally. Licensing determines product entitlement; Entra roles determine human authority.

## Current scope

The branch implements deployment configuration, Entra validation, connector governance, customer-managed Observation API source profiles, portal routes, licensing, and audit persistence. Live Teams commands, Exchange polling, source-scoped machine credentials, customer-vault resolution, and the Starlings process adapter are separate runtime slices and are not represented as operational merely because an integration has been saved.
