# Integration lifecycle

> **Current surface status.** The catalog, governed lifecycle, authority model, and sync worker
> described below are implemented and tested in the daemon (`apps/server/src/agent/catalog.ts`,
> `service.ts`, `sync-worker.ts`). The **HTTP API and portal page are not exposed**: every
> `/api/integrations/*` path returns 404 by design, and there is no `/portal/integrations` view.
> Integration configuration is intended to become conversational through agent tools, which is
> not implemented yet. See [decisions/0001-portal-surface.md](decisions/0001-portal-surface.md).
> The `POST`/`GET` paths below therefore describe the daemon's internal contract, not a live
> network surface.

The integration domain is the control surface for human adapters, evidence sources, terrain
sources, controlled executors, agent peers, and secret infrastructure. It is currently
daemon-internal.

Observation API sources are registered active immediately because they grant no outbound or action authority:

`connect → waiting for data → receiving | degraded | disabled`

Selecting **Connect** on a catalog card was intended to open the ingestion terminal immediately. That portal surface is not currently exposed. The intended behavior is that the source remains out of **Operational integrations** until the first accepted observation, then appears as **RECEIVING**.

Integrations that establish outbound access, hold external credentials, or execute controlled actions retain the governed lifecycle:

`draft → tested → awaiting_approval → active → degraded | disabled`

A deterministic test checks manifest compatibility, endpoint policy, scope, and credential references. When a connector driver is registered, the same transition also performs its live reachability and authentication test. Without a driver it records `networkReachability: not_tested`, and health remains `unknown` rather than being reported as healthy.

## Observation API sources

The daemon defines one Observation API. Configuring Zeek, Suricata, Sysmon, DNS, Asset Inventory, Microsoft Entra, Defender XDR, or Sentinel registers a source identity, its allowed schemas, and a source-bound route inside the daemon:

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

The catalog modal exposes two **advanced validation workflows**:

- **Validate one record** checks authentication, schema acceptance, normalization, and Terrain projection with a single example.
- **Developer NDJSON bridge** tails a customer-produced JSON-lines file and wraps each record in the selected source schema. It is for custom integration development and controlled troubleshooting, not sustained collection.

The bridge is not a Papyrus collector. Source-specific export configuration, buffering, retry, and operating permissions remain under customer control. When the modal opens, the authenticated portal session requests a one-hour daemon-signed ingestion token scoped to that integration. The generated command receives it as `PAPYRUS_INGEST_TOKEN`; the browser never exposes or copies the user's Entra access token. A token cannot publish to another integration, and disabling or deleting its integration makes the route reject observations.

For production telemetry, prefer a native SIEM, EDR, OTEL, email, or OT connector. Long-running custom producers must use a customer-approved workload identity or mTLS, durable local spooling, batching, checkpointing, bounded retry, and a dead-letter/health path rather than repeatedly issuing interactive setup tokens.

Deleting an integration tombstones its configuration and invalidates its ingestion route. Previously accepted evidence and its append-only provenance remain in Terrain; deletion does not rewrite historical evidence.

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
