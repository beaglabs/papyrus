# Integration lifecycle

`/portal/integrations` is the control surface for human adapters, evidence sources, terrain sources, controlled executors, agent peers, and secret infrastructure.

Each connector follows:

`draft → tested → awaiting_approval → active → degraded | disabled`

A deterministic test checks manifest compatibility, endpoint policy, scope, and credential references. When a connector driver is registered, the same transition also performs its live reachability and authentication test. Without a driver it records `networkReachability: not_tested`, and health remains `unknown` rather than being reported as healthy.

## Observation API sources

The Papyrus daemon exposes one Observation API. Configuring Zeek, Suricata, Sysmon, DNS, Asset Inventory, Microsoft Entra, Defender XDR, or Sentinel registers a source identity, its allowed schemas, and a source-bound route inside that daemon:

`POST /api/integrations/:id/observations`

Activation does not provision another service or endpoint. The integration identifier establishes source provenance. Papyrus does not trust a caller-provided `source` field and does not poll these systems. The customer owns collection, export configuration, network routing, and source-system permissions.

The **Custom Source** profile accepts customer-defined evidence and canonical Terrain projections. Curated profiles additionally accept versioned native schemas such as `zeek.conn@1`, `suricata.eve.alert@1`, and `asset.device@1`.

### Canonical Terrain mode

Customers that already know the desired topology can publish raw evidence and its projection together:

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

### Source-native mode

A curated source can instead publish its native fields under a versioned `schema`:

```json
{
  "sourceRecordId": "zeek-conn-918281",
  "observedAt": "2026-09-02T07:00:00Z",
  "schema": "zeek.conn@1",
  "payload": {
    "uid": "CTo78A11gLkU",
    "id.orig_h": "10.0.0.12",
    "id.orig_p": 51822,
    "id.resp_h": "10.0.0.8",
    "id.resp_p": 443,
    "proto": "tcp"
  }
}
```

Papyrus retains the accepted raw record and schema provenance alongside the projection produced by the pinned deterministic normalizer. A record must use either `schema` or `terrain`, never both. Schemas are constrained by the configured source profile, so a Zeek integration cannot submit a Suricata schema. Invalid source-native records are rejected without partially mutating Terrain and can be corrected and retried under the same source record identifier.

The active integration's **Ingestion setup** dialog provides two terminal workflows:

- **Stream NDJSON** continuously tails a customer-produced JSON-lines file and wraps each record in the selected source schema before sending it to the daemon.
- **Send one record** validates authentication, schema acceptance, normalization, and Terrain projection with a single example.

The stream command is a bridge, not a collector: source-specific export configuration remains under customer control, and every input line must match the selected versioned schema. The daemon endpoint currently accepts the caller's Entra bearer token and requires `Papyrus.Integration.Manage`; source-scoped non-human publishing credentials remain a production hardening slice.

`GET /api/terrain` returns the resulting entity/relationship snapshot.

## Pull synchronization runtime

Operational integrations that genuinely require daemon-managed polling execute through the database-backed worker. Jobs use leases, bounded exponential retry, durable cursors, and idempotent source record identifiers. An observation is committed before its checkpoint advances. A daemon restart or expired worker lease therefore resumes work without silently skipping evidence.

`POST /api/integrations/:id/sync` queues a pull connector immediately, and `GET /api/integrations/:id/sync-jobs` exposes its execution history. The current evidence and Terrain source profiles do not use this path.

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
