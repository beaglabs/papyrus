# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This document is not an authorization decision, certification, or claim that Papyrus satisfies every control in a regulatory framework.

## System identification and boundary

Papyrus is a secure agent gateway/control plane for regulated and disconnected environments. The repository boundary includes the TypeScript web application, server, ACP runtime contract, shared application contracts, deployment manifests, and the governed session workspace implementation.

Supported deployment profiles are `commercial`, `government-il4`, and `government-il6`. Persistent deployments are expected to provide production transport, identity, runtime, and licensing controls defined by the server configuration.

## Identity and transport

- Commercial deployments use OIDC or an authenticated trusted identity proxy for remote access.
- Government profiles reject OIDC and use CAC/PIV-compatible mTLS identity paths.
- Remote gateway listeners require mTLS; development tokens are restricted to local/loopback use.
- Persistent government profiles require a FIPS-enabled Node/OpenSSL runtime.

## Authorization and tool governance

- Authorization is implemented with a fixed Cedar policy and explicit role/action mappings.
- Session and environment access is scoped to ownership/assignment.
- Runtime tools are mapped through an exact allowlist; unknown tools have no policy mapping.
- Browser and workspace actions remain explicit policy actions rather than implicit agent capabilities.

## Session workspace and execution isolation

- Session file access uses a contained workspace filesystem.
- Command execution is exposed only when an OS isolation backend is available and passes a runtime probe.
- Seatbelt uses deny-by-default rules and denies network access.
- Bubblewrap unshares namespaces and binds only the session workspace read/write.
- Workspace command networking is disabled, filesystem delete is disabled, and read-before-write is required.
- Host-launched LSP inspection remains disabled until it can share the command isolation boundary.

## Audit and integrity

Papyrus records authorization/audit events in an append-only hash chain. Each event includes its previous event hash and the fixed policy version, providing tamper-evident ordering for exported audit evidence.

## Supply-chain and change-control evidence

- pnpm is the canonical package manager and the lockfile is frozen in CI.
- `compliance/sbom.spdx.json` is generated from the staged pnpm lockfile and workspace package manifests.
- `compliance/contracts.manifest.json` fingerprints the public shared-contract and ACP-runtime surfaces.
- Local pre-commit guardrails scan staged changes for secrets, unsafe workspace escapes, debug junk, contract drift, filename collisions, frontend accessibility regressions, and Markdown rendering fixtures.

## Evidence fingerprints

The values below are Git blob IDs from the candidate Git index. A change to a security-boundary source changes this generated SSP and requires the updated evidence artifact to be staged.

| Evidence source | Git blob |
| --- | --- |
| `apps/server/src/config.ts` | `5052d41eff817ed7183803b559d025f5e1bbb697` |
| `apps/server/src/policy.ts` | `69d4ec4df28cb7a6095b8aab83f1cc78933d0806` |
| `apps/server/src/audit.ts` | `7557ecd61c7f16a048d1442d1e90a2a3b13b33a4` |
| `apps/server/src/catalog.ts` | `2f1571d04a249232baf3abcc5f042e31e3b0a2b4` |
| `apps/server/src/mastra/authorization.ts` | `dfea8e778a23059763a8ef358cbbc045e2e2e706` |
| `apps/server/src/mastra/sandbox.ts` | `d578bd973d09e3f75c70443e413c8f7c9e2f903e` |
| `apps/server/src/mastra/workspace.ts` | `1b187f977169d265fc13abcef2000bc565718cb8` |
| `apps/server/src/mastra/tools.ts` | `5bc1bc3e9b360cbf3668c26459c4ebc17b5326c8` |
| `packages/contracts/src/index.ts` | `c15a10504a55d1f387e2e00a1bd11f2598242d53` |
| `packages/acp-runtime/src/index.ts` | `343d6e56bf7bb19a80f5ae8dc9052360593193dc` |

## Regeneration

Run `pnpm compliance:generate` to regenerate this SSP, the contract manifest, and the SPDX SBOM. Pre-commit and CI use `pnpm compliance:check` to fail when tracked compliance evidence is stale.
