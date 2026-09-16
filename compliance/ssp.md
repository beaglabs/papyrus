# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, approved action executors, and the approval-backed Links publication and serving boundary.

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
| `apps/server/src/agent/config.ts` | `061bb55db27f9155e7ca5f7489050a650ee117b7` |
| `apps/server/src/agent/http.ts` | `dd54a48515cbd24dddba0a45d13839bfc9852bb8` |
| `apps/server/src/agent/action-worker.ts` | `edee5c81e503ea46f5596c806c73b39884e0383f` |
| `apps/server/src/agent/catalog.ts` | `961c8baa2e9e925042fd875556998099eb73ac07` |
| `apps/server/src/agent/link-store.ts` | `75cb2a0dd381bc622ad9c3b79e76083ccc944ddb` |
| `apps/server/src/agent/link-http.ts` | `d6a0eee9c661f64a9258ee0858074c9a5f5dfbbf` |
| `apps/server/src/agent/link-preview.ts` | `fc30c91eea30af9999019d6bc0c565240e13ace7` |
| `apps/server/src/agent/executors/link-publisher-executor.ts` | `7f31a74af751f8d7009d1667f835b35890663cbd` |
| `apps/server/src/agent/mastra/runtime.ts` | `1ab29e831905e156c9763d0c66a472a70e414137` |
| `apps/server/src/agent/mastra/workspace-agentfs.ts` | `c2b86023b6a6e33270fc07c745afc63c2fff55b3` |
| `apps/server/src/agent/mastra/workspace-nono.ts` | `a9e50594c17b07afc03e14d50b76b4dfc2c8da77` |
| `apps/server/src/agent/mastra/workspace-nono-worker.ts` | `98ab23dc87241b7149f4e1a58348d627ca75bfb3` |
| `apps/server/src/agent/mastra/workspace-enclave.ts` | `b0aa5ca567e243cdb6fc930cdd294b52311c12aa` |

## Regeneration

Run `pnpm compliance:generate`. CI and the pre-commit hook run `pnpm compliance:check`.
