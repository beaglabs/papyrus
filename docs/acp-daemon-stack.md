# ACP daemon stacked pull-request plan

Status: accepted  
Merge order: bottom-up  
Repository rule: every stack branch lives in `beaglabs/papyrus`

Each pull request targets the branch immediately below it. Reviewers therefore see only that layer's change. The stack follows GitHub's native stacked pull-request model.

## Stack

| Layer | Branch | Pull-request base | Scope |
| --- | --- | --- | --- |
| 01 | `stack/acp-01-baseline` | `main` | Daemon boundary, production licensing invariant, CI baseline, and architecture decisions |
| 02 | `stack/acp-02-runtime-core` | `stack/acp-01-baseline` | Runtime-neutral ACP core using `@agentclientprotocol/sdk` |
| 03 | `stack/acp-03-local-stdio` | `stack/acp-02-runtime-core` | Local process supervision and ACP stdio |
| 04 | `stack/acp-04-auth-bff` | `stack/acp-03-local-stdio` | OIDC/PKCE, CAC/PIV federation, direct mTLS, and bootstrap hardening |
| 05 | `stack/acp-05-governed-session` | `stack/acp-04-auth-bff` | Durable session ownership, Cedar enforcement, and audit events |
| 06 | `stack/acp-06-remote-http` | `stack/acp-05-governed-session` | Authenticated and bounded Streamable HTTP with mTLS |
| 07 | `stack/acp-07-external-proxy` | `stack/acp-06-remote-http` | Single-endpoint ACP mediation and a stdio-to-remote connector |
| 09 | `stack/acp-09-adapter-catalog` | `stack/acp-07-external-proxy` | Runtime and connector profiles, including browser capability through Chrome ACP |
| 11 | `stack/acp-11-hardened-image` | `stack/acp-09-adapter-catalog` | Minimus Node 24 FIPS image and deployment hardening |

Layers 08 and 10 are intentionally absent. Papyrus is not building a web-session client, and browser support is composed from layers 07 and 09.

## Layer gates

### 01 — Baseline

- Persistent licensing cannot be disabled through environment configuration.
- Documentation consistently describes a daemon, not a chat client.
- Node and pnpm versions agree across package metadata and CI.
- Every later branch and base is recorded before implementation begins.

### 02 — Runtime core

- Replace the Goose-named core package with a runtime-neutral package.
- Keep ACP types at the boundary; do not leak adapter-specific types.
- Define runtime launch, connection, capability, session, event, cancellation, and health contracts.
- Retain Goose only as an adapter behind those contracts.

### 03 — Local stdio

- Supervise one process per runtime connection or documented shared-process policy.
- Implement message framing, stdout/stderr separation, cancellation, timeout, exit classification, and cleanup.
- Prove clean shutdown and crash recovery with fixture runtimes.

### 04 — Auth BFF

- Keep tokens and certificate material server-side.
- Implement OIDC discovery, PKCE, state, nonce, issuer, audience, and session revocation.
- Support direct CAC/PIV mTLS and approved certificate-to-OIDC federation.
- Trust forwarded certificate identity only over an authenticated proxy boundary.

### 05 — Governed sessions

- Persist owner, workspace, runtime assignment, connector, lifecycle, approvals, and normalized events.
- Enforce every protected operation through the Cedar service.
- Make reconnect and resume semantics explicit and runtime-capability aware.
- Hash-chain security-relevant audit events.

### 06 — Remote transports

- Make Streamable HTTP the primary remote transport.
- Retain WebSocket only as a compatibility adapter.
- Require connection identifiers, bounded frames, cancellation, timeouts, and authenticated channels.
- Exercise transports against an independent fixture runtime.

### 07 — External proxy

- Expose a real ACP-to-ACP proxy at `/acp/<runtimeId>`.
- Add `papyrus-connect`, a minimal stdio-to-remote bridge for spawn-only clients.
- Remove dependence on `GOOSE_SERVER__SECRET_KEY` from external client configuration.
- Route model and MCP access through Papyrus policy boundaries.

### 09 — Adapter catalog

- Define validated runtime and connector manifests without arbitrary shell interpolation.
- Ship optional profiles for Goose and at least one independent ACP runtime.
- Add a Chrome ACP connector profile and Cedar action mapping.
- Treat browser navigation, downloads, uploads, credentials, and submissions as separately governed actions.

### 11 — Hardened image

- Use a pinned Node 24 `reg.mini.dev/node-fips` runtime image and immutable digest.
- Verify `crypto.getFips() === 1`.
- Run non-root with a read-only root filesystem, dropped capabilities, and no embedded secrets.
- Copy only compiled output and production dependencies into the runtime stage.
- Publish and verify Papyrus SBOM, provenance, signature, vulnerability scan, and compliance reports.

## Stack maintenance

When a lower layer changes, rebase and push its up-stack dependents before requesting review. Merge approved layers from the bottom upward. After merges, synchronize and prune merged branches using GitHub's stack tooling.

Unit, type, protocol, and policy checks run on every layer. Expensive end-to-end, image, and compliance jobs may use GitHub stack metadata to run only on the top pull request while the stack is under review.
