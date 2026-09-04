# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, Starlings integration, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, approved action executors, and the approval-backed Links publication and serving boundary.

## Security invariants

- External side effects cross the proposal → human approval → ledger → leased executor boundary.
- AgentFS is the durable file authority; native processes work through bounded materialize → isolate → reconcile behavior.
- Link publication snapshots exact AgentFS bytes before approval and verifies the SHA-256 again before making the Link live.
- Link drafts, published blobs, and inbound payloads remain under /Library/Links in the same Workspace filesystem.
- Webpage Links are served as static documents with a restrictive CSP and without Papyrus-injected presentation styles or scripts.
- API Links serve approved JSON snapshots or explicitly bound durable workflows.
- Webhook and mutable API inbounds are bounded, stored in AgentFS, hashed, and surfaced into the agent investigation path.
- Kitesurf is optional validation only; it is not the hosting authority and is not configurable for government, restricted, or disconnected profiles.
- nono applies kernel-backed filesystem authority and blocks network access for workspace command execution.
- AgentScript runs in Enclave STRICT and receives only Papyrus-brokered capabilities.
- Credential-like environment variables are stripped before workspace commands execute.
- Contract, workspace, frontend, secret, filename, and generated evidence drift checks run before commit and in CI.

## Evidence fingerprints

| Evidence source | Git blob |
| --- | --- |
| `apps/server/src/agent/config.ts` | `288d607bac86deda4f53f8f795900b960d4f59cf` |
| `apps/server/src/agent/http.ts` | `15aebf08aa0ff019933ebdbd3a972ab31cdde35e` |
| `apps/server/src/agent/action-worker.ts` | `edee5c81e503ea46f5596c806c73b39884e0383f` |
| `apps/server/src/agent/catalog.ts` | `e31ac4a9b8f39775708149ba4a3a5e883c577dcd` |
| `apps/server/src/agent/link-store.ts` | `0d3aab3b385ebab5a77cb39ab4ae50ae191d13e1` |
| `apps/server/src/agent/link-http.ts` | `efcfd2b2cb53edff3192c2ebe92e6a46d2e00c2e` |
| `apps/server/src/agent/link-preview.ts` | `fc30c91eea30af9999019d6bc0c565240e13ace7` |
| `apps/server/src/agent/executors/link-publisher-executor.ts` | `7f31a74af751f8d7009d1667f835b35890663cbd` |
| `apps/server/src/agent/mastra/workspace-agentfs.ts` | `c2b86023b6a6e33270fc07c745afc63c2fff55b3` |
| `apps/server/src/agent/mastra/workspace-nono.ts` | `f3ad0004c050eff5658ddc5af62015cea2b40c01` |
| `apps/server/src/agent/mastra/workspace-nono-worker.ts` | `0dcadce525f5f77664a580ceb444382ace17c0d1` |
| `apps/server/src/agent/mastra/workspace-enclave.ts` | `18527b84887f2937733fb88c65d127e9e52164ee` |

## Regeneration

Run `pnpm compliance:generate`. CI and the pre-commit hook run `pnpm compliance:check`.
