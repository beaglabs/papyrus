# Cyber twin security model

## Identity and authority

Microsoft Entra ID is the only human identity and role authority. Papyrus validates issuer, tenant, audience, signature, expiry, and OIDC nonce where applicable. Accepted audiences are the application client ID and its `api://` form. Only declared Papyrus application roles are honored.

There is no local user database, password login, invitation flow, bootstrap owner, or Papyrus role assignment. Removing an Entra assignment removes authority when the Microsoft token and short-lived portal cookie expire. Deployments requiring faster revocation should use appropriately short Entra token lifetimes and boundary revocation controls.

## Operational safety

Identity authorization and cyber-action safety are separate:

- Entra determines who may configure, approve, or inspect.
- Connector lifecycle policy determines whether a connector can become active.
- Action-capable connectors require `Papyrus.Security.Manage`.
- Individual consequential actions are represented as proposals and require explicit policy/approval before execution.

Starlings may produce observations, claims, conflicts, and action proposals. It does not bypass the deterministic release boundary.

## Connector invariants

- Inline passwords, secrets, private keys, API keys, and tokens are rejected.
- Configurations store only customer-vault, certificate, or managed-identity references.
- Non-loopback endpoints require HTTPS.
- Observation sources register active immediately and cannot perform outbound or controlled actions. Integrations that establish outbound access or action authority follow draft, tested, approval, and active states.
- Integration deletion is a configuration tombstone: the route is invalidated and the integration disappears from active configuration, while accepted evidence and its audit chain remain append-only.
- The portal never exposes a user's Entra access token to command-generation JavaScript. It exchanges the HttpOnly portal session for a one-hour HMAC-signed ingestion token containing only an integration ID, issuer audit identity, nonce, and expiration. Issuance is recorded in the integration's append-only audit history; observation routes reject expired, modified, or cross-source tokens.
- Configuration and lifecycle events are append-only and SHA-256 hash chained.
- A configuration test validates deterministic policy and manifest requirements; it does not claim live network reachability.

## Honest limitations

- A host or database administrator can replace local state. Export the audit chain to independently controlled immutable storage for external tamper evidence.
- Microsoft national-cloud support and tenant app approval vary by environment.
- Papyrus is not a cross-domain solution, authorization to operate, or claim of GCC High, DoD, IL4, IL6, or SIPR accreditation.
- Versioned source-profile normalizers, operational connector drivers, and the Starlings runtime adapter must receive their own threat modeling and verification as they are added.
