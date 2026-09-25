# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, approved action executors, and the approval-backed Links publication and serving boundary.

## Security invariants

- External side effects cross the proposal → human approval → ledger → leased executor boundary.
- Governance → Approvals is the authoritative workspace decision surface; Agent sessions and Links only originate or project durable action proposals.
- AgentFS is the durable file authority; native processes work through bounded materialize → isolate → reconcile behavior.
- Link publication snapshots exact AgentFS bytes before approval and verifies the SHA-256 again before making the Link live.
- Link drafts, published blobs, logos, assets, and inbound payloads remain under /Library/Links in the same Workspace filesystem.
- Webpage Links are served as static documents with a restrictive CSP and without Papyrus-injected presentation styles or scripts.
- API Links serve approved JSON snapshots or explicitly bound durable workflows.
- Webhook Links are scoped to the creating Mastra {resourceId, threadId}; WebhookSignalProvider routes each inbound event back into that exact session.
- Webhook Action Executor attachments are durable configuration only; inbound webhook traffic never receives executor authority directly and matching automatic actions become new action proposals before execution.
- Webhook executor attachment and detachment changes themselves cross the proposal → approval → Papyrus Links executor boundary.
- Webhook executor timeout and retry settings may tighten worker behavior but cannot expand the deployment-level retry ceiling.
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
| `apps/server/src/agent/http.ts` | `a489dd950477b09eab269bb6fa0ac700bd3af409` |
| `apps/server/src/agent/action-worker.ts` | `3bead8248aafa7833f83f5f49157f6ab25353370` |
| `apps/server/src/agent/catalog.ts` | `f57c95522643997327121ca926e1637058ea32fd` |
| `apps/server/src/agent/link-store.ts` | `75cb2a0dd381bc622ad9c3b79e76083ccc944ddb` |
| `apps/server/src/agent/link-executor-attachments.ts` | `57bc0dc3ca5a52c8f04542080b423aa847c21b32` |
| `apps/server/src/agent/link-http.ts` | `a84df327a95a12c9052a7084881276ff6514ef2f` |
| `apps/server/src/agent/link-preview.ts` | `fc30c91eea30af9999019d6bc0c565240e13ace7` |
| `apps/server/src/agent/executors/link-publisher-executor.ts` | `5df3f1b24badca58e367d252cda90c7d1576964a` |
| `apps/server/src/agent/mastra/runtime.ts` | `1ab29e831905e156c9763d0c66a472a70e414137` |
| `apps/server/src/agent/mastra/workspace-agentfs.ts` | `c2b86023b6a6e33270fc07c745afc63c2fff55b3` |
| `apps/server/src/agent/mastra/workspace-nono.ts` | `a9e50594c17b07afc03e14d50b76b4dfc2c8da77` |
| `apps/server/src/agent/mastra/workspace-nono-worker.ts` | `98ab23dc87241b7149f4e1a58348d627ca75bfb3` |
| `apps/server/src/agent/mastra/workspace-enclave.ts` | `b0aa5ca567e243cdb6fc930cdd294b52311c12aa` |

## Regeneration

Run `pnpm compliance:generate`. CI and the pre-commit hook run `pnpm compliance:check`.
