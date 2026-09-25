# Hosted App Links and Policy Subagents

Design for `beaglabs/papyrus`, stacked on `feat/session-scoped-connectors` at `c346b8bce724dad32c5afe3c06fac649b0fa2b31` (PR #173).

Status: proposed design, not an implemented feature.

## Outcome

Operators create an App Link, describe changes to an agent, edit its project in Monaco, and inspect a live internal preview. Publishing proposes an immutable production build for Governance approval. Hosted apps inherit the deployment's Microsoft Entra authentication. Apps receive explicit durable connector grants rather than inheriting their author's session access.

Named deterministic policies apply across workspace, app, session, connector, executor, skill, agent, model, and link boundaries. A Policy specialist can create restrictions and provably strengthen them. It cannot grant capabilities, weaken restrictions, approve its own changes, or bypass existing authorization.

## Existing code and invariants

- `packages/contracts/src/index.ts` currently defines `webpage | api | webhook`.
- `apps/server/src/agent/link-store.ts` snapshots individual AgentFS files and persists Links. Its SQLite type constraint must be migrated; adding a TypeScript union member alone is insufficient.
- `apps/server/src/agent/link-http.ts` serves existing public Links before portal authentication. App code and app assets must never reach that serving path.
- `apps/server/src/agent/executors/link-publisher-executor.ts` executes approved publication proposals. The new publication operation must preserve this approval boundary.
- `apps/server/src/agent/session-connector-access.ts` establishes session authority through AsyncLocalStorage and checks the current integration at dispatch. The model cannot supply its own authoritative session ID.
- `apps/server/src/agent/service.ts` checks executor bindings when actions are proposed and approved. `action-worker.ts` checks again immediately before execution.
- `apps/server/src/agent/mastra/enhanced-runtime.ts` already defines tool-limited specialists. The Policy specialist belongs here.
- Credential references remain opaque. App manifests, grants, session state, policy records, logs, and browser responses must not contain provider tokens or credential values.

## Approach and alternatives

Use the existing Papyrus control plane, AgentFS, action ledger, Entra authentication, and governed execution infrastructure. Introduce focused app and policy modules rather than embedding the new subsystems in the existing large runtime module.

Extending ordinary webpage Links would be smaller, but their public, script-disabled serving model cannot safely host authenticated interactive applications. An independent app platform would offer more flexibility, but would duplicate authentication, Governance, storage, and audit controls. The selected approach reuses those controls while keeping generated code outside the control-plane origin and process.

## App project and manifest

An app has a stable ID, owner, workspace, authoring session, AgentFS project root, draft revision, build status, and optional current release. Its Link has type `app`; app status distinguishes draft, building, awaiting approval, live, and failed.

The project root contains `papyrus.app.json`, application source, a package manifest, and a dependency lockfile. The versioned app manifest identifies the entry point, supported build preset, public output directory, inherited Entra auth, and requested connector capabilities. It contains references to policies and integrations, never credentials. Capability requests are declarations, not grants.

Start with a supported React/TypeScript/Vite preset. Treat build commands and project dependencies as untrusted input. Custom server processes and arbitrary deployment scripts are outside this initial runtime; application data operations go through the governed app bridge.

All paths must resolve within the app project. Reject absolute paths, traversal, symlink escapes, duplicate normalized paths, reserved runtime paths, and oversized manifests/files. Build snapshots enumerate every included file and its digest. AgentFS remains the source authority; host filesystem access is limited to an isolated build staging directory.

## Builder and live preview

The internal neobrutalist builder has resizable Agent, Code, and Preview panels, a file explorer, a status strip, and explicit Publish action. Use the existing visual system: strong borders, hard shadows, flat colors, clear controls, and accessible focus states.

The Agent panel uses an owned authoring session and the existing prompt/event infrastructure. Monaco reads and saves project files through authenticated APIs. Saves carry an expected revision to prevent silently overwriting concurrent edits. Agent edits and manual edits share the same revision stream.

An authenticated event subscription reports source revisions, build progress, preview readiness, and errors. Coalesce rapid edits and discard stale build completions. A last-known-good preview remains visible when a new build fails, clearly labeled with its revision. Successful builds update the preview automatically; use HMR where the selected isolated runner supports it, otherwise reload the preview when the new revision is ready. The UI must not label reload fallback as HMR.

Generated preview code runs in an isolated preview origin, not in a same-origin iframe with control-plane privileges. No connector secret, portal cookie, or broad API token enters the iframe. A narrow host bridge validates the exact frame window and origin, uses a per-frame nonce, and mediates only app-scoped operations. Preview requests use authoring-session authority; production requests use durable app grants. The bridge rejects messages after frame replacement or session revocation.

The status strip shows inherited Entra auth, preview/build revision, production release, session connector status, durable app connector status, and effective policies. These statuses remain visibly distinct.

## Build and publication

1. Capture an immutable project revision and lockfile.
2. Build in the configured isolated runner with resource, time, filesystem, and outbound-network limits. Never execute generated build scripts in the Papyrus control-plane process.
3. Record source digest, build recipe/version, output file digests, entry point, requested capabilities, and policy references in an immutable release candidate.
4. Create a publication proposal in the existing action ledger, containing the candidate ID and canonical candidate digest. Governance sees the exact build and capability changes being proposed.
5. Approval applies to that candidate only. The executor rereads the candidate, verifies every artifact hash, reevaluates current authorization/policies, and atomically advances the live release pointer.

Agent edits never advance the production pointer. Editing a pending candidate creates a new candidate and requires a new approval. Publication is idempotent for an approved candidate; failed builds or failed activation leave the previous release intact. Rolling back selects a verified immutable release through the same governed activation flow.

App policy and connector changes take effect independently of rebuilding frontend code. Revocation or stronger restrictions apply immediately to existing releases. A release never pins an obsolete policy in order to evade current restrictions.

## Entra-authenticated hosted runtime

Hosted app entry routes authenticate through the existing deployment Entra configuration and tenant validation, then check portal/workspace access and effective app policies. Inherited authentication is the default and the only initial authentication mode. No public/anonymous fallback is introduced.

Serve a trusted authenticated host shell and load generated content from a separate, configured app-content origin. Generated code has no ambient authority over the portal. The content service must deny direct artifact retrieval without a valid app-and-release-scoped authorization mechanism; serving a public bundle behind an authenticated shell is not sufficient.

Use a short-lived, revocable opaque app session restricted to the authenticated principal, app, and release. Store only a hash of its identifier server-side, keep it out of URLs and logs, and never expose the portal credential. Validate app sessions for every asset/data request and recheck app availability and current grants. Cookies and origin/CSP settings must reflect the actual deployment topology; startup validation rejects an unsafe same-origin configuration.

Extend login return-path validation to explicitly allow canonical app entry paths, preserving protection against open redirects. Existing public webpage/API/webhook behavior remains unchanged. Unknown `app` requests at the legacy public Link handler fail closed instead of falling through to webhook handling.

## Connector authority and execution

Persist durable app grants separately from `agent_session_connectors`. A grant names app, integration, exact capability/action set, any resource constraints, approving principal, approval record, revision, and revocation state. Integration activation and credential rotation remain controlled by existing integration administration.

Creating or expanding a durable grant requires Governance approval. Attaching a connector to an authoring session cannot create an app grant. App manifests cannot grant themselves capabilities. Revoking a grant or disabling an integration blocks later dispatch, including previously queued actions.

Introduce a trusted discriminated execution scope: session or app. Its identifiers come from authenticated server runtime context, never tool arguments. An app scope carries principal, app, release, and invocation identity. Runtime authority intersects the caller's permitted access, the durable app grant, integration state, existing executor authorization, and effective deterministic policies.

Connector tools resolve the exact integration within the current scope and check the requested operation before client access. Preserve PR #173's session-binding behavior. There is no fallback from a missing app grant to an author's session binding or deployment-wide integration.

App writes become action proposals in the existing ledger. Persist their trusted app scope with the proposal/job so workers can enforce it after restarts. Proposal, approval, and final execution each reevaluate applicable policies and grants. The internal Links executor's existing exemption does not grant an app general executor authority.

## Named deterministic policies

Policies have a stable ID, unique workspace name, version, author, immutable rule revisions, audit history, and attachments. The initial rule language is structured data with bounded, deterministic operators: allow-set restrictions, deny sets, required approval, and numeric upper limits. It cannot execute JavaScript, call a model, fetch a URL, or inspect secrets.

Policy decisions are restrictions over existing authority. An allow-set limits an already authorized set; it never authorizes an integration or action by itself. Applicable policies compose by intersection, deny wins, and approval requirements accumulate. Missing required context, invalid rules, unsupported versions, and unavailable policy state fail closed. The result includes stable reason codes and matched policy revisions.

Attachments address workspace, app, session, connector, executor, skill, agent, model, or link IDs. A server-derived context resolver gathers applicable attachments; callers cannot omit workspace or inherited scopes to escape restrictions. A model dispatch includes its agent and model; a skill invocation includes the skill; connector/action/app/link dispatch includes those exact resource identities plus inherited scopes.

Enforce decisions at both service admission and low-level dispatch. UI state and prompt instructions are explanations, not enforcement. Audit policy decisions without recording sensitive inputs.

## Policy specialist and Governance

The Policy specialist receives only list/read, create-restriction, attach-restriction, strengthen, evaluate/dry-run, and propose-governed-change tools. It receives no approval, raw database, credential, arbitrary code-execution, or grant-writing tool. Its scope is inherited from the authenticated requesting session.

Prove strengthening structurally: an allow-set may shrink, a deny set may grow, an approval requirement may be added, and an upper limit may decrease. The existing protected rule/attachment remains in effect. Reject changes that cannot be proven monotonic from the autonomous path and create a Governance proposal instead.

Removing or disabling a policy, deleting an attachment, broadening a selector, changing a rule to a non-comparable form, expanding a limit, removing an approval requirement, or granting any capability requires Governance approval. A specialist may not attach restrictions to resources outside its authorized workspace/scope.

Approval records bind the exact old revision and proposed new digest. Concurrent changes invalidate stale approvals. Apply updates and audit records atomically. Governed changes require the established security-management permission and action approval boundary; merely being an app author does not suffice.

## APIs and user interface

Add authenticated app APIs for list/create, project/file read/write, revision events, build/preview status, release candidate creation, publication proposal, and connection/policy status. Every authoring operation verifies ownership/workspace access. State-changing browser requests use existing CSRF/origin protections, extended where necessary.

Add Policies navigation with named policy list, deterministic rule editor, attachments, version history, dry-run results, and pending governed changes. Show why a change needs approval. Add App Link cards that open the builder and show live/draft status; production URLs open the authenticated app host.

Governance displays publication candidates, connector grant requests, and non-monotonic policy changes with meaningful diffs, requesting principal, affected resources, and exact hashes/revisions.

## Modules, contracts, and migrations

Keep app project storage, build/release management, runtime authorization, HTTP routing, and frontend builder as separate modules. Keep policy validation/evaluation pure and separate from persistent policy storage and approval orchestration.

Extend shared contracts for App Links, manifests, revisions, candidates/releases, grants, policy rules/decisions/attachments, and governed changes. Update every exhaustive Link-type switch and runtime schema together.

Add versioned, restart-safe SQLite migrations for app projects, candidates/releases, runtime grants, app sessions, policy revisions/attachments/proposals, and trusted action origin metadata. Rebuild the existing Link table constraint transactionally while preserving indexes, events, existing rows, and inbound references. Test migration from a populated pre-change database and reapplication.

Generate and check compliance contract manifests using the repository's tooling. Update the SSP, architecture documentation, deployment configuration, threat model, and operating instructions with app origin isolation, build sandboxing, inherited Entra auth, grant revocation, policy change authority, and credential-reference handling. Documentation must describe tested guarantees and known limitations accurately.

## Verification and completion criteria

- A project can be created, prompted, edited in Monaco, and previewed after both agent and manual edits. Concurrent edits produce an explicit conflict. Failed builds retain the labeled last-known-good preview.
- An app cannot publish without approval. Candidate or artifact tampering, stale approvals, duplicate execution, and build/publish races are tested. Agent edits cannot alter a live release.
- Anonymous, wrong-tenant, expired-session, and revoked-access requests cannot retrieve app HTML, scripts, assets, or invoke the bridge. Login return paths and encoded traversal cases are tested.
- Generated frames cannot call portal APIs with ambient credentials, impersonate another frame, reuse revoked bridge state, or receive secrets. Browser tests validate the actual origin/cookie/CSP configuration.
- Session bindings do not satisfy app grants and vice versa. Cross-app/integration/capability access is denied. Revocation between proposal, approval, and execution is enforced, including worker restart.
- Policy evaluation tests every attachment point, inherited context, deny/intersection semantics, malformed rules, missing context, deterministic results, monotonic changes, stale approvals, and unauthorized attachment changes.
- The Policy specialist can create and strengthen restrictions but cannot approve, weaken, detach, or grant authority through alternate tools.
- Existing session connector, public Link, action approval, authentication, and worker tests continue to pass. New tests follow the repository's `agent-*.test.ts` discovery pattern.
- Run relevant server/web tests, typechecks, production builds, contract drift and compliance checks; fix failures attributable to this change. Report any unrelated baseline failure precisely.
- Create a stacked pull request targeting `feat/session-scoped-connectors` with implementation, migration/deployment instructions, evidence from checks, and explicit limitations. Do not merge or deploy as part of this request.

## Implementation order

1. Shared contracts, migration tests, and pure policy evaluator.
2. Persistent policy revisions, attachments, governed updates, and dispatch enforcement.
3. App project/release storage and separate runtime connector grants.
4. Isolated build/preview runner and immutable publication executor.
5. Authenticated hosted runtime and scoped app bridge.
6. Policy specialist, Policies UI, builder UI, and Governance integration.
7. End-to-end security/regression coverage, compliance updates, CI validation, and stacked PR.

Each stage must maintain the existing fail-closed behavior; unfinished routes and capabilities remain unavailable until their enforcement is connected.
