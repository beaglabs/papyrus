# Papyrus daemon deployment

Papyrus runs as a customer-hosted, single-deployment daemon. Teams, Exchange, ACP, A2A peers, and security products connect to the daemon; none is required for the runtime to remain available.

## Deployment profile

Papyrus has exactly three deployment profiles:

| Profile | Purpose |
| --- | --- |
| `commercial` | Connected commercial/enterprise deployment. |
| `government` | Connected government deployment with hardened network/model defaults. |
| `disconnected` | Disconnected or air-gapped deployment with no assumption of external service reachability. |

GCC, GCC High, DoD, IL4, IL6, SIPR, and classification levels are **not Papyrus deployment profiles**. National cloud selection, customer authorization boundaries, and information classification are separate concerns.

## Identity boundary

Persistent deployments require one customer-owned Microsoft Entra application registration when Entra is used. Configure application roles from the root README and assign them in Entra. Papyrus validates Microsoft-issued tokens and derives a one-hour, HTTP-only portal cookie from those claims. It does not create a user, invitation, password, group, or local role record.

Select the Entra national cloud independently of `PAPYRUS_PROFILE`:

| `PAPYRUS_ENTRA_CLOUD` | Microsoft environment |
| --- | --- |
| `Public` | Microsoft commercial/public cloud |
| `USGov` | Azure Government / Microsoft US Government endpoints |
| `USGovDoD` | Microsoft DoD national-cloud endpoints |

Papyrus does not infer accreditation or impact level from that setting. The operator remains responsible for selecting the correct national-cloud endpoints and deploying within the customer-approved boundary.

## Classification marking capability

Papyrus does not show a classification banner merely because a deployment uses the `government` or `disconnected` profile. Classification marking is a separately licensed capability.

The signed license must contain:

```text
classification-banners
```

The deployment then selects its actual displayed marking with:

```bash
PAPYRUS_CLASSIFICATION=secret
```

Supported values are:

- `unclassified`
- `cui`
- `confidential`
- `secret`
- `top-secret`
- `top-secret-sci`

Both conditions are required. `PAPYRUS_CLASSIFICATION` cannot create a banner unless the locally verified signed license grants `classification-banners`, and a licensed deployment renders no banner when `PAPYRUS_CLASSIFICATION` is unset or empty. Invalid values are rejected rather than silently mapped to another marking.

Any legacy `classification:<level>` feature present in an already-issued signed license is not used to choose the displayed marking. The customer-owned deployment configuration is authoritative for the actual system banner while the signed capability remains authoritative for whether Papyrus is entitled to render classification markings at all.

## Platform requirements

Papyrus's agent workspace is local-first. AgentFS is the durable workspace filesystem, backed by local SQLite under `PAPYRUS_DATA_DIR`; cloud sync is not required. Native workspace execution is isolated through the packaged Landlock/seccomp boundary on supported Linux hosts and is disabled rather than silently run unconfined when the required isolation cannot be provided.

The workspace process chain materializes a bounded AgentFS view, executes inside the configured sandbox, reconciles approved filesystem changes back into AgentFS, and removes the materialized workspace. Credential-like environment variables are stripped before workspace child processes are spawned.

The supported appliance image and vendored runtime dependencies are described in [deployment-vhd.md](deployment-vhd.md).

### Deployment shape

A deployment requires a writable `PAPYRUS_DATA_DIR` and its configured listening ports. The daemon must never be given `privileged: true`; Papyrus does not require an all-powerful container merely to execute governed workspace commands.

## Agent configuration

The agent needs a model, and choosing one is the customer's decision. Government and disconnected profiles do not inherit a public commercial model endpoint. Papyrus requires an explicitly approved endpoint for those profiles, except for a local loopback provider such as Ollama.

```bash
# Optional one-time bootstrap; durable model profiles can be configured at /portal/models.
export PAPYRUS_AGENT_MODEL='openai/gpt-5'
export PAPYRUS_MODEL_BASE_URL='https://approved-model-endpoint.example/v1'
export PAPYRUS_MODEL_CREDENTIAL_REF='env://OPENAI_API_KEY'
```

Without a model, Mastra storage, session history, workflows, and connector state can still start while work that requires a model remains unavailable. The Models surface stores gateway metadata and customer-owned credential references; it does not require Papyrus to persist raw model secrets.

Storage is LibSQL, split by lifecycle rather than kept in one file: `<data-dir>/mastra.db` holds session threads and messages, `<data-dir>/jobs.db` holds schedules and background jobs, and `<data-dir>/observability.db` holds trace spans and logs. All belong in the deployment backup plan.

## Document toolchain

Provision the approved document/tooling environment once per appliance rather than asking agents to download or invent parsers at runtime. The sandbox may receive read-only access to those explicitly provisioned toolchain paths while outbound network access remains governed separately.

## Runtime modes

- `local`: loopback evaluation. It may use `PAPYRUS_DEV_ENTRA_PRINCIPAL`.
- `persistent`: durable customer deployment. It requires production identity configuration, a portal signing secret, durable storage, and normally a signed offline license.

Persistent mode is intended for a supervised customer-hosted deployment. Back up runtime databases and connector configuration, store keys and connector credentials in customer-controlled secret infrastructure, and export audit evidence to independently controlled storage where required.

## Interface availability

Teams and Exchange are adapters, not runtime dependencies. GCC High or DoD tenants use the appropriate `PAPYRUS_ENTRA_CLOUD` value while the Papyrus deployment profile remains `government`. Disconnected deployments can omit Microsoft adapters and use locally reachable portal, ACP, A2A, and approved security connectors.

## Licensing

`GET /api/license/request` returns the deployment identity and selected Papyrus profile. A Beag licensing authority signs a license containing the deployment ID, permitted profiles, product features, issue time, and optional expiry. Papyrus verifies the signature locally; no Beag cloud callback is required during normal disconnected operation.

Licensing determines product entitlement. Deployment profile determines runtime posture. Entra/national-cloud configuration determines identity endpoints. Customer authorization determines what environment the deployment is approved to operate in. Those are deliberately separate concepts.

## Current scope

The branch implements deployment configuration, Entra validation, connector governance, customer-managed source profiles, portal routes, offline licensing, and audit persistence. Saving a connector or selecting a profile is not itself an accreditation, authorization, or classification decision.