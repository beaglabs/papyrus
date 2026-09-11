# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, Starlings integration, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, approved action executors, and the approval-backed Links publication and serving boundary.

## Security invariants

- External side effects cross the proposal → human approval → ledger → leased executor boundary.
- AgentFS is the durable file authority; native processes work through bounded materialize → isolate → reconcile behavior.
- Link publication snapshots exact AgentFS bytes before approval and verifies the SHA-256 again before making the Link live.
- Link drafts, published blobs, logos, assets, and inbound payloads remain under /Library/Links in the same Workspace filesystem.
- Webpage Links are served as static documents with a restrictive CSP and without Papyrus-injected presentation styles or scripts.
- API Links serve approved JSON snapshots or explicitly bound durable workflows.
- Webhook Links are scoped to the creating Mastra {resourceId, threadId}; WebhookSignalProvider routes each inbound event back into that exact session.
- Webhook Links are the public dynamic-ingestion primitive; legacy Plugin connection and integration-scoped signal webhook routes are not exposed by the portal API.
- Recurring work is managed through session-scoped Agent tools; the public scheduler CRUD/page surface is not exposed.
- Webhook logo identity is snapshotted with the approved Link rather than loaded from an untrusted mutable URL.
- Kitesurf is optional validation only; it is not the hosting authority and is not configurable for government, restricted, or disconnected profiles.
- nono applies kernel-backed filesystem authority and blocks network access for workspace command execution.
- AgentScript runs in Enclave STRICT and receives only Papyrus-brokered capabilities.
- Credential-like environment variables are stripped before workspace commands execute.
- Contract, workspace, frontend, secret, filename, and generated evidence drift checks run before commit and in CI.

## Evidence fingerprints

| Evidence source | Git blob |
| --- | --- |
| `apps/server/src/agent/config.ts` | `552fb9bf10069fdfa8a9874de2323c7e2fbb5a5c` |
| `apps/server/src/agent/http.ts` | `80b5919eafa105959ad1813c5551a022bd89b6a5` |
| `apps/server/src/agent/action-worker.ts` | `edee5c81e503ea46f5596c806c73b39884e0383f` |
| `apps/server/src/agent/catalog.ts` | `bfc6157d7319270f72cc5392d0eed583a406de68` |
| `apps/server/src/agent/link-store.ts` | `774cef0cce09023d636a0c654ea2a3e5d3a58ee2` |
| `apps/server/src/agent/link-http.ts` | `528c4307baf755403d62219869318dc3935922ec` |
| `apps/server/src/agent/link-preview.ts` | `fc30c91eea30af9999019d6bc0c565240e13ace7` |
| `apps/server/src/agent/executors/link-publisher-executor.ts` | `7f31a74af751f8d7009d1667f835b35890663cbd` |
| `apps/server/src/agent/mastra/runtime.ts` | `28b458f8bb2728bcc326ea5763fd0e6355001b85` |
| `apps/server/src/agent/mastra/workspace-agentfs.ts` | `c2b86023b6a6e33270fc07c745afc63c2fff55b3` |
| `apps/server/src/agent/mastra/workspace-nono.ts` | `80f6ff30dc91cb10fe4b5370b1e93831fb4d09ef` |
| `apps/server/src/agent/mastra/workspace-nono-worker.ts` | `0dcadce525f5f77664a580ceb444382ace17c0d1` |
| `apps/server/src/agent/mastra/workspace-enclave.ts` | `18527b84887f2937733fb88c65d127e9e52164ee` |

## Regeneration

Run `pnpm compliance:generate`. CI and the pre-commit hook run `pnpm compliance:check`.
