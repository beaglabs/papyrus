# Cyber twin architecture

Papyrus is the governed customer-hosted envelope around a Starlings cyber-resilience population.

| Plane | Responsibility | Authority |
| --- | --- | --- |
| Human connection | Teams commands, Exchange email, portal | Entra identity and app roles |
| Machine connection | ACP clients and A2A peers | Connector credentials and scoped manifests |
| Evidence | Defender, Sentinel, Zeek, Suricata, Sysmon, terrain sources | Read-only connector scope |
| Computation | Local observations, claims, contradiction handling, recovery | Starlings population rules |
| Action | Firewall or response proposals and execution | Deterministic policy plus Entra approver |
| Product | Configuration, licensing, health, audit | Papyrus daemon |

Papyrus deliberately does not turn Teams into the runtime. An adapter translates a Teams command into a typed request and returns a result; loss of Teams does not stop evidence ingestion, Starlings computation, portal access, ACP/A2A traffic, or email.

The portal is initiated either by normal Entra login or a short-lived link created from an authenticated adapter flow. A URL parameter is not itself an identity credential and must not contain a durable bearer token.

The canonical flow is:

1. Pull connectors run as leased, resumable synchronization jobs; push connectors enter through the observation boundary.
2. The daemon commits immutable source observations before advancing a connector checkpoint.
3. Normalization projects evidence-backed entities and relationships into Terrain while retaining source and observation provenance.
4. Starlings operators consume the durable observation boundary to form claims, request missing evidence, and resolve contradictions.
5. The cyber twin retains the current terrain and confidence history.
6. Potentially consequential output becomes an action proposal.
7. Policy and an appropriately assigned Entra principal decide whether the action is released.
8. Every configuration and decision transition is auditable.

Integration configuration is never Terrain. The graph contains only entities and relationships produced from observations. The connector identifier and source record identifier remain attached as provenance rather than appearing as synthetic graph nodes.

The same substrate can be tested under message loss, operator loss, partitions, contradictory evidence, and recovery without changing the product boundary.
