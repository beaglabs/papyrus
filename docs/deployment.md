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

Papyrus's agent workspace is local-first and has two deliberately separate
providers:

- **AgentFS** is the durable `WorkspaceFilesystem`, backed by `agentfs-sdk` over
  a local SQLite database under `PAPYRUS_DATA_DIR/.agentfs`. Cloud sync is not
  enabled or required.
- **nono** is the `WorkspaceSandbox` and process boundary, applied in process by
  the `nono-ts` native addon. Commands see only the materialized workspace, and
  outbound network is never granted.

No filesystem is mounted. AgentFS materializes the workspace into a real
directory for the lifetime of a command, `nono-ts` confines the process to it,
and the result is reconciled back into AgentFS:

| Host | nono isolation | Workspace execution |
| --- | --- | --- |
| Linux | Landlock | Supported |
| macOS | Seatbelt | Supported |
| Windows | — | Disabled |

The workspace process chain is:

```text
Mastra Workspace tool
       |
       v
NonoProcessManager.spawn
       |
       v
AgentFS materializeForExecution()  ->  real workspace directory
       |
       v
node workspace-nono-worker.js <control.json>
       |
       v
nono-ts CapabilitySet.apply()      (Landlock on Linux, Seatbelt on macOS)
       |
       v
/bin/sh -c <command>
       |
       v
AgentFS reconcileExecution()       ->  cleanupExecution()
```

Only the materialized workspace is writable, along with the explicit read-only
toolchain paths Papyrus provisioned, such as `<data-dir>/python`. AgentFS remains
the filesystem source of truth across sessions: the materialized directory exists
only for the lifetime of a command, and its changes are reconciled back into the
database. Papyrus also removes credential-like environment variables before
spawning workspace processes.

`nono-ts` is a platform-specific native addon. Linux deployments need the glibc
(`gnu`) build present in the image, together with the `@tursodatabase/database`
and `libsql` native drivers. The daemon never downloads a sandbox, database
driver, or filesystem runtime at execution time, so all three must be vendored
into the approved image. The image contents and deployment shape are specified in
[deployment-vhd.md](deployment-vhd.md).

There is no AgentFS CLI and no mount daemon to stage, so `agentfs`, `nono`, and
the `PAPYRUS_AGENTFS_BINARY` / `PAPYRUS_NONO_BINARY` overrides are not part of
this path.

The older `PAPYRUS_SANDBOX_RUNTIME=bwrap|seatbelt` selector is retained for
configuration compatibility only; the Mastra workspace path does not use
`LocalSandbox`, and Bubblewrap is not required on a Linux deployment.

### Deployment shape

Because nothing is mounted, workspace execution needs no mount capability, no
`/dev/fuse`, and no elevated capabilities. A deployment requires a writable
`PAPYRUS_DATA_DIR` and its listening ports, and nothing else. The daemon must
never be given `privileged: true`, and no deployment needs it.

## Agent configuration

The agent needs a model, and choosing one is the customer's decision — `disconnected` and `restricted` profiles cannot reach a hosted provider at all. Papyrus will not guess a default.

```bash
# Optional one-time bootstrap; durable profiles can be configured at /portal/models.
export PAPYRUS_AGENT_MODEL='openai/gpt-5'
export PAPYRUS_MODEL_BASE_URL='https://api.openai.com/v1'
export PAPYRUS_MODEL_CREDENTIAL_REF='env://OPENAI_API_KEY'
```

Without it the agent is not registered. Mastra storage, session history, workflows, and plugin configuration still start normally, while signals accumulate durably in `agent_signal_outbox`. Nothing is dropped while unconfigured. The Models tab stores only gateway metadata and a customer-owned credential reference; it never stores raw key material.

Storage is LibSQL, split by lifecycle rather than kept in one file: `<data-dir>/mastra.db` holds session threads and messages, `<data-dir>/jobs.db` holds schedules and background jobs, and `<data-dir>/observability.db` holds trace spans and logs. All three are created alongside the main database, and all three belong in a backup — a session export alone does not carry the recurring work that outlives it.

The Mastra API surface this depends on, and the version it was verified against, is recorded in [mastra-integration.md](mastra-integration.md). Check it before upgrading Mastra.

## Document toolchain

Agent code execution runs the host's programs, and a host Python with no libraries makes document work pathological: an agent asked to read a PDF has no reader, so it writes one, and spends its step budget debugging its own parser instead of producing the deliverable.

Provision the environment once per appliance:

```bash
PAPYRUS_DATA_DIR=/var/lib/papyrus scripts/provision-python.sh
```

That creates `<data-dir>/python` with `pypdf` (PDF text, layout, and embedded images), `reportlab` (styled PDF output with fonts, colours, geometry, and placed images), and `pillow` (image inspection and conversion). The daemon detects it automatically and the sandbox grants read-only access to that directory — nothing else under the data directory becomes readable to workspace commands, and outbound network stays blocked at agent time. Set `PAPYRUS_PYTHON_BIN` to override the interpreter, and `PAPYRUS_LIBREOFFICE_BIN` when LibreOffice is installed somewhere the PATH lookup does not cover (the daemon tries `libreoffice`, then macOS `soffice`). Without the provisioned environment everything still runs; the agent just has the host's bare interpreter.


## Runtime modes

- `local`: loopback evaluation. It may use `PAPYRUS_DEV_ENTRA_PRINCIPAL`.
- `persistent`: durable customer deployment. It requires real Entra configuration, TLS, a portal signing secret, durable storage, and normally a signed offline license. On Linux it enables sandboxed agent code execution through `nono-ts` and Landlock, and requires the vendored native drivers described above. The supported appliance image is specified in [deployment-vhd.md](deployment-vhd.md).

Persistent mode uses SQLite in WAL mode and is intended for a supervised single-node deployment. Back up the database and connector configuration, store keys and connector credentials in customer-controlled secret infrastructure, and export audit events to independently controlled storage.

## Interface availability

Teams is an adapter, not a runtime dependency. GCC High and DoD application deployment must follow the customer's approved national-cloud process. Email and the authenticated portal can operate without Teams. Disconnected deployments can omit Microsoft adapters and use locally reachable portal, ACP, A2A, and security connectors.

## Licensing

`GET /api/license/request` returns the deployment identity. A licensing authority signs a license containing that deployment ID, profiles, features, issue time, and optional expiry. Papyrus verifies the signature locally. Licensing determines product entitlement; Entra roles determine human authority.

## Current scope

The branch implements deployment configuration, Entra validation, connector governance, customer-managed Observation API source profiles, portal routes, licensing, and audit persistence. Live Teams commands, Exchange polling, source-scoped machine credentials, and customer-vault resolution are separate runtime slices and are not represented as operational merely because an integration has been saved.
