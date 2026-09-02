# Integration lifecycle

`/portal/integrations` is the control surface for human adapters, evidence sources, terrain sources, controlled executors, agent peers, and secret infrastructure.

Each connector follows:

`draft → tested → awaiting_approval → active → degraded | disabled`

A deterministic test checks manifest compatibility, endpoint policy, scope, and credential references. When a connector driver is registered, the same transition also performs its live reachability and authentication test. Without a driver it records `networkReachability: not_tested`, and health remains `unknown` rather than being reported as healthy.

## Synchronization runtime

Pull and hybrid connectors execute through the daemon's database-backed worker. Jobs use leases, bounded exponential retry, durable cursors, and idempotent source record identifiers. An observation is committed before its checkpoint advances. A daemon restart or expired worker lease therefore resumes work without silently skipping evidence.

Push connectors publish to `POST /api/integrations/:id/observations`. The first source-neutral adapter is the catalog's **Observation API** connector. Its payload can carry raw source data plus an optional normalized Terrain projection:

```json
{
  "sourceRecordId": "sensor-record-1042",
  "observedAt": "2026-09-02T07:00:00Z",
  "evidenceType": "NetworkConnection",
  "subject": "device:workstation-1",
  "payload": { "rawSourceFields": "are preserved" },
  "terrain": {
    "entities": [
      { "externalId": "device:workstation-1", "kind": "Device", "label": "Workstation 1" },
      { "externalId": "ip:10.0.0.8", "kind": "IPAddress", "label": "10.0.0.8" }
    ],
    "relationships": [
      { "kind": "connected_to", "sourceExternalId": "device:workstation-1", "targetExternalId": "ip:10.0.0.8" }
    ]
  }
}
```

`GET /api/terrain` returns the resulting entity/relationship snapshot. `POST /api/integrations/:id/sync` queues a pull connector immediately, and `GET /api/integrations/:id/sync-jobs` exposes its execution history.

## Authority

| Operation | Entra application role |
| --- | --- |
| View catalog and health | Any assigned Papyrus role |
| Read Terrain and sync history | `Papyrus.Integration.View` |
| Create, test, submit ordinary connector | `Papyrus.Integration.Manage` |
| Publish observations or queue a pull sync | `Papyrus.Integration.Manage` |
| Activate ordinary connector | `Papyrus.Integration.Manage` |
| Activate high-risk or action-capable connector | `Papyrus.Security.Manage` |
| Disable action-capable connector | `Papyrus.Security.Manage` |
| Read connector audit events | `Papyrus.Audit.View` |

`Papyrus.System.Owner` implies all portal permissions.

## Credential references

The database accepts opaque references using `vault://`, `keyvault://`, `secret://`, `cert://`, or `managed-identity://`. Secret values are resolved at the connector-driver execution boundary and never returned to the browser. A production connector driver must provide the corresponding customer-vault resolver.

Connector manifests also declare supported deployment profiles, evidence types, capabilities, risk, authority, authentication schemes, and license feature. These declarations are policy inputs; they do not substitute for a connector-specific threat model.
