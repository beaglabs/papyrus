# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, Starlings integration, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, and approved action executors.

## Security invariants

- External side effects cross the proposal → human approval → ledger → leased executor boundary.
- AgentFS is the durable file authority; native processes work through bounded materialize → isolate → reconcile behavior.
- nono applies kernel-backed filesystem authority and blocks network access for workspace command execution.
- AgentScript runs in Enclave STRICT and receives only Papyrus-brokered capabilities.
- Credential-like environment variables are stripped before workspace commands execute.
- Contract, workspace, frontend, secret, filename, and generated evidence drift checks run before commit and in CI.

## Evidence fingerprints

| Evidence source | Git blob |
| --- | --- |
| `apps/server/src/agent/config.ts` | `e1923ae44105e3c1df858670ec7e0a55086b5740` |
| `apps/server/src/agent/http.ts` | `4c0af560ea6f41ec0453ed0f1524f0deedd4f63c` |
| `apps/server/src/agent/action-worker.ts` | `edee5c81e503ea46f5596c806c73b39884e0383f` |
| `apps/server/src/agent/mastra/workspace-agentfs.ts` | `f8fd58884ec7864944858b1ebdb1fdd0125918f7` |
| `apps/server/src/agent/mastra/workspace-nono.ts` | `f3ad0004c050eff5658ddc5af62015cea2b40c01` |
| `apps/server/src/agent/mastra/workspace-nono-worker.ts` | `0dcadce525f5f77664a580ceb444382ace17c0d1` |
| `apps/server/src/agent/mastra/workspace-enclave.ts` | `18527b84887f2937733fb88c65d127e9e52164ee` |

## Regeneration

Run `pnpm compliance:generate`. CI and the pre-commit hook run `pnpm compliance:check`.
