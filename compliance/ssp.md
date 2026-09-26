# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, approved action executors, and the approval-backed Links and hosted App publication and serving boundaries.

## Security invariants

- External side effects cross the proposal → human approval → ledger → leased executor boundary.
- AgentFS is the durable file authority; native processes work through bounded materialize → isolate → reconcile behavior.
- Link publication snapshots exact AgentFS bytes before approval and verifies the SHA-256 again before making the Link live.
- Hosted App publication approves an immutable, digest-checked build candidate; source edits and preview builds never advance the production pointer.
- Hosted App content is served from a separate HTTPS origin in a script-only sandbox. Entra authentication and brokered connector access remain on the portal origin.
- App runtime connector grants are durable and operation-specific, separate from the authoring session's bindings; low-level dispatch rechecks grants and active connector state.
- Named, attached policy rules are evaluated deterministically. The policy specialist cannot activate an authority-weakening change without Governance approval.
- Link drafts, published blobs, logos, assets, and inbound payloads remain under /Library/Links in the same Workspace filesystem.
- Webpage Links are served as static documents with a restrictive CSP and without Papyrus-injected presentation styles or scripts.
- API Links serve approved JSON snapshots or explicitly bound durable workflows.
- Webhook Links are scoped to the creating Mastra {resourceId, threadId}; WebhookSignalProvider routes each inbound event back into that exact session.
- Webhook Links are the public dynamic-ingestion primitive; legacy Plugin connection and integration-scoped signal webhook routes are not exposed by the portal API.
- Recurring work is managed through session-scoped Agent tools; the public scheduler CRUD/page surface is not exposed.
- Webhook logo identity is snapshotted with the approved Link rather than loaded from an untrusted mutable URL.
- Kitesurf is optional validation only; it is not the hosting authority and is not configurable for government or disconnected profiles.
- nono applies kernel-backed filesystem authority and blocks network access for workspace command execution.
- AgentScript runs in Enclave STRICT and receives only Papyrus-brokered capabilities.
- Credential-like environment variables are stripped before workspace commands execute.
- Contract, workspace, frontend, secret, filename, and generated evidence drift checks run before commit and in CI.

## Evidence fingerprints

| Evidence source | Git blob |
| --- | --- |
| `apps/server/src/agent/config.ts` | `9577a8ecd5f3cefd6d72f99f94db86a23610aff3` |
| `apps/server/src/agent/http.ts` | `42df7968d276a031a443abd05ac98fff825cc067` |
| `apps/server/src/agent/action-worker.ts` | `b52c389ad099b5c2a573ff368f96dae3f08ca97e` |
| `apps/server/src/agent/apps/http.ts` | `f8daeb6228cd9a74bb3f73110a31c9d08e21c76b` |
| `apps/server/src/agent/apps/store.ts` | `5e28d03ee09c4541905a4d9d291b6ddd8c5e0f56` |
| `apps/server/src/agent/apps/migration.ts` | `e9c341bbd9f55b89beff4ec4eea1ac3631c8b269` |
| `apps/server/src/agent/policies/store.ts` | `54a6a167ed3b97d3bec4a07f049bd367a969d013` |
| `apps/server/src/agent/policies/runtime.ts` | `74bf2b1eecee6b0abd52ce24abb40a3fd2adb541` |
| `apps/server/src/agent/session-connector-access.ts` | `3995b791819defc900067a2af901174c5b1b1a95` |
| `apps/server/src/agent/catalog.ts` | `f57c95522643997327121ca926e1637058ea32fd` |
| `apps/server/src/agent/link-store.ts` | `11c06d078c9c728c920648c1043db2704a64d68e` |
| `apps/server/src/agent/link-http.ts` | `ec8d8a21497fc96048c7173f8a0e84d67401293a` |
| `apps/server/src/agent/link-preview.ts` | `fc30c91eea30af9999019d6bc0c565240e13ace7` |
| `apps/server/src/agent/executors/link-publisher-executor.ts` | `7f31a74af751f8d7009d1667f835b35890663cbd` |
| `apps/server/src/agent/mastra/runtime.ts` | `1c0b8206a9a7bd2ba0fc0a2bf23154e0de0a6d2e` |
| `apps/server/src/agent/mastra/workspace-agentfs.ts` | `c2b86023b6a6e33270fc07c745afc63c2fff55b3` |
| `apps/server/src/agent/mastra/workspace-nono.ts` | `2893ce217b551b187574055ef5c736fb37fa953a` |
| `apps/server/src/agent/mastra/workspace-nono-worker.ts` | `98ab23dc87241b7149f4e1a58348d627ca75bfb3` |
| `apps/server/src/agent/mastra/workspace-enclave.ts` | `b0aa5ca567e243cdb6fc930cdd294b52311c12aa` |

## Regeneration

Run `pnpm compliance:generate`. CI and the pre-commit hook run `pnpm compliance:check`.
