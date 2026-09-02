# Cyber twin deployment

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

## Runtime modes

- `local`: loopback evaluation. It may use `PAPYRUS_DEV_ENTRA_PRINCIPAL`.
- `persistent`: durable customer deployment. It requires real Entra configuration, TLS, a portal signing secret, durable storage, and normally a signed offline license.

Persistent mode uses SQLite in WAL mode and is intended for a supervised single-node deployment. Back up the database and connector configuration, store keys and connector credentials in customer-controlled secret infrastructure, and export audit events to independently controlled storage.

## Interface availability

Teams is an adapter, not a runtime dependency. GCC High and DoD application deployment must follow the customer's approved national-cloud process. Email and the authenticated portal can operate without Teams. Disconnected deployments can omit Microsoft adapters and use locally reachable portal, ACP, A2A, and security connectors.

## Licensing

`GET /api/license/request` returns the deployment identity. A licensing authority signs a license containing that deployment ID, profiles, features, issue time, and optional expiry. Papyrus verifies the signature locally. Licensing determines product entitlement; Entra roles determine human authority.

## Current scope

The branch implements deployment configuration, Entra validation, connector governance, customer-managed Observation API source profiles, portal routes, licensing, and audit persistence. Live Teams commands, Exchange polling, source-scoped machine credentials, customer-vault resolution, and the Starlings process adapter are separate runtime slices and are not represented as operational merely because an integration has been saved.
