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

- **AgentFS** is the durable `WorkspaceFilesystem`. Its SQLite database lives
  under `PAPYRUS_DATA_DIR/.agentfs`; cloud sync is not enabled or required.
- **nono** is the `WorkspaceSandbox` and process boundary. Commands are launched
  with only the AgentFS workspace writable and outbound network blocked.

Papyrus drives AgentFS's local transient mount backend according to the host:

| Host | AgentFS command view | nono isolation | Workspace execution |
| --- | --- | --- | --- |
| Linux | FUSE | Landlock | Supported |
| macOS | NFS | Seatbelt | Supported |
| Windows | — | — | Disabled |

Both `agentfs` and `nono` must be present in the deployment image or on the
customer-controlled host before Papyrus starts an agent with workspace tools.
Disconnected deployments should vendor the binaries into their approved image;
the daemon never downloads a sandbox or filesystem runtime at execution time.

The default executable names can be overridden when the binaries are staged in
a fixed approved location:

```bash
export PAPYRUS_AGENTFS_BINARY=/opt/papyrus/bin/agentfs
export PAPYRUS_NONO_BINARY=/opt/papyrus/bin/nono
export PAPYRUS_AGENTFS_ID=papyrus-workspace
```

The workspace process chain is:

```text
Mastra Workspace tool
       |
       v
Papyrus SandboxProcessManager
       |
       v
agentfs exec --backend fuse|nfs <local-db>
       |
       v
nono run --allow-cwd --block-net
       |
       v
requested command
```

AgentFS remains the filesystem source of truth across sessions. The transient
FUSE/NFS mount exists only for the lifetime of a command. nono then constrains
the command to that mounted workspace and blocks network access. Papyrus also
removes credential-like environment variables before spawning workspace
processes.

The older `PAPYRUS_SANDBOX_RUNTIME=bwrap|seatbelt` selector is retained for
configuration compatibility, but the Mastra workspace path no longer uses
`LocalSandbox`; new workspace execution uses nono.

### Container note

AgentFS FUSE/NFS mounts need the corresponding host/container mount support.
The hardened Kubernetes manifest intentionally does not add broad privileges
just to make workspace execution function. A deployment that enables workspace
commands must explicitly provide the approved mount capability/device for its
platform, or run the daemon on a host where AgentFS can mount normally. The
daemon must not be given `privileged: true` as a shortcut.

## Agent configuration

The agent needs a model, and choosing one is the customer's decision — `disconnected` and `restricted` profiles cannot reach a hosted provider at all. Papyrus will not guess a default.

```bash
# Optional one-time bootstrap; durable profiles can be configured at /portal/models.
export PAPYRUS_AGENT_MODEL='openai/gpt-5'
export PAPYRUS_MODEL_BASE_URL='https://api.openai.com/v1'
export PAPYRUS_MODEL_CREDENTIAL_REF='env://OPENAI_API_KEY'
```

Without it the agent is not registered. Mastra storage, session history, workflows, and plugin configuration still start normally, while signals accumulate durably in `agent_signal_outbox`. Nothing is dropped while unconfigured. The Models tab stores only gateway metadata and a customer-owned credential reference; it never stores raw key material.

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

The branch implements deployment configuration, Entra validation, connector governance, customer-managed Observation API source profiles, portal routes, licensing, and audit persistence. Live Teams commands, Exchange polling, source-scoped machine credentials, and customer-vault resolution are separate runtime slices and are not represented as operational merely because an integration has been saved.
