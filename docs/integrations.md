# Integration lifecycle

`/portal/integrations` is the control surface for human adapters, evidence sources, terrain sources, controlled executors, agent peers, and secret infrastructure.

Each connector follows:

`draft → tested → awaiting_approval → active → degraded | disabled`

A deterministic test checks manifest compatibility, endpoint policy, scope, and credential references. It records `networkReachability: not_tested` until a real connector driver performs a live check.

## Authority

| Operation | Entra application role |
| --- | --- |
| View catalog and health | Any assigned Papyrus role |
| Create, test, submit ordinary connector | `Papyrus.Integration.Manage` |
| Activate ordinary connector | `Papyrus.Integration.Manage` |
| Activate high-risk or action-capable connector | `Papyrus.Security.Manage` |
| Disable action-capable connector | `Papyrus.Security.Manage` |
| Read connector audit events | `Papyrus.Audit.View` |

`Papyrus.System.Owner` implies all portal permissions.

## Credential references

The database accepts opaque references using `vault://`, `keyvault://`, `secret://`, `cert://`, or `managed-identity://`. Secret values are resolved at the execution boundary by a future secret-provider adapter and never returned to the browser.

Connector manifests also declare supported deployment profiles, evidence types, capabilities, risk, authority, authentication schemes, and license feature. These declarations are policy inputs; they do not substitute for a connector-specific threat model.
