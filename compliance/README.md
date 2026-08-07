# Papyrus security and OSCAL

This directory contains Papyrus security-control documentation intended to help a customer incorporate the self-hosted product into its own Risk Management Framework (RMF), System Security Plan (SSP), assessment, and authorization workflow.

## Artifact

[`papyrus-component-definition.json`](./papyrus-component-definition.json) is an OSCAL 1.2.1 Component Definition covering 35 selected NIST SP 800-53 Revision 5 controls. It describes potential contributions made by the Papyrus software component and identifies responsibility as:

- `papyrus` — implemented primarily by application behavior;
- `shared` — Papyrus provides a mechanism and the customer configures or operates it;
- `customer` — performed inside the customer-owned authorization boundary; or
- `inherited` — supplied by the operating system, platform, enclave, or another provider.

The artifact is not a FedRAMP package, SSP, Security Assessment Report, certification, authorization, or assertion that a deployment satisfies the referenced controls. A customer must tailor the statements, bind them to deployed component instances, supply inherited controls, attach evidence, and assess effectiveness within its actual boundary.

## Papyrus-specific security topics

### Identity and access

Papyrus uses `PAPYRUS_PROFILE` to gate available authentication methods. SIPRNet/IL6 is CAC/PIV-only; NIPRNet/IL4 supports CAC/PIV and WebAuthn; commercial deployments support WebAuthn, OIDC, and SAML. External identities are bound to Papyrus member keys, while customer identity providers remain authoritative for account lifecycle, proofing, recovery, and revocation.

### Cryptography and keys

Relevant material includes member identity keys, TLS certificates, SAML IdP certificates, OIDC verification keys, Iroh identities, license-signing keys, and customer-managed storage encryption keys. Deployments requiring FIPS validation must select and verify validated cryptographic modules; use of a generally approved algorithm is not by itself a FIPS claim.

### Audit and evidence

Security-relevant events include authentication, credential enrollment and removal, membership and role changes, project lifecycle, node/specification changes, agent and skill execution, MCP tool use, model endpoint changes, peer activity, cross-domain export, backup/restore, and administrative configuration. Evidence should include event samples, integrity verification, tests, SBOMs, scan results, release hashes, configuration exports, and operating procedures.

### Agent and MCP boundaries

Agent security should document tool authorization, human approval gates, skill provenance, MCP allowlists, prompt/tool separation, secret redaction, input validation, egress restrictions, endpoint allowlists, execution limits, auditability, failure handling, and acceptance of generated changes.

### Peer networking

Papyrus uses Iroh with encrypted QUIC streams and customer-controlled peer discovery or relay topology. Deployment documentation must cover direct versus relayed paths, permitted peers, relay ownership and allowlisting, ports, metadata exposure, peer revocation, offline behavior, segmentation, and cross-domain boundaries.

### Data protection

Papyrus stores project data, credentials, configuration, and audit information locally. Customers own storage permissions, volume or disk encryption, backup protection, retention, deletion, host hardening, and key custody. Documentation must also account for prompts, model responses, exports, caches, and any configured telemetry.

### Software supply chain

Release evidence should include SPDX or CycloneDX SBOMs, the pnpm lockfile, vulnerability and license scans, build provenance, release hashes or signatures, container/base-image provenance when applicable, supported-version policy, remediation targets, and end-of-life notices.

## Recommended customer tailoring workflow

1. Select the applicable customer baseline or OSCAL profile.
2. Import this Component Definition into the customer SSP authoring workflow.
3. Instantiate Papyrus and its supporting components inside the actual boundary.
4. Replace generic shared-responsibility language with the approved deployment configuration.
5. Add inherited controls for the OS, enclave, IdP, storage, network, monitoring, model server, and backup platform.
6. Attach evidence and define assessment procedures.
7. Track deviations and findings through the customer's assessment and POA&M processes.

## Maintenance

Update the document UUID and `metadata.last-modified` whenever the OSCAL content changes. Increase the artifact version for material control or architecture changes, validate against the matching NIST OSCAL schema, and retain released versions with the corresponding Papyrus release.
