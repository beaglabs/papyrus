# Mastra integration notes

Verified by reading the published `@mastra/core` **1.63.2** type declarations, not by
inference. Re-check these against the installed version before relying on them —
the export surface has moved between Mastra releases, which is why `runtime.ts`
imports the harness dynamically and feature-detects everything.

Mastra is installed in the server workspace. To independently re-verify the
published API surface:

```bash
mkdir -p /tmp/mastra-probe && cd /tmp/mastra-probe
npm pack @mastra/core@<version>
tar xzf mastra-core-<version>.tgz && mv package mastra-core-<version>
# then read mastra-core-<version>/dist/**/*.d.ts
```

## Confirmed export locations

| Symbol | Subpath | Notes |
| --- | --- | --- |
| `Agent` | `@mastra/core/agent` | Also re-exported from `@mastra/core` |
| `createTool` | `@mastra/core/tools` | |
| `Memory` | `@mastra/memory` | Uses the same `LibSQLStore` as the Mastra instance |
| `handleChatStream` | `@mastra/ai-sdk` | Portal transport uses AI SDK UI v7 |
| `WebhookSignalProvider` | `@mastra/core/signals` | HTTP mounting and subscription rehydration remain Papyrus responsibilities |
| `createEventedAgent` | `@mastra/core/agent/durable` | Wraps the Papyrus agent for durable execution |
| `MastraFilesystem`, filesystem types | `@mastra/core/workspace` | Papyrus extends this for the AgentFS-backed provider |
| `MastraSandbox`, `SandboxProcessManager`, `ProcessHandle` | `@mastra/core/workspace` | Papyrus extends these for nono-backed execution |
| `Workspace`, `WorkspaceConfig` | `@mastra/core/workspace` | There is no `@mastra/core/sandbox` subpath; sandbox types live under `workspace` |
| `MastraCompositeStore` | `@mastra/core/storage` | Not re-exported from `@mastra/core`. Composes storage domains from different adapters |

## Storage domains

Papyrus splits storage by lifecycle instead of keeping one adapter on one file, because session
purge, job retention, and trace retention are different operations:

| File | Domains | Lifecycle |
| --- | --- | --- |
| `mastra.db` | every domain except the overrides below | session threads and messages; deleted with the session |
| `jobs.db` | `schedules`, `backgroundTasks` | work that outlives the conversation it was created in |
| `observability.db` | `observability` | traces and logs; grows fastest, retained separately |

`MastraCompositeStore` takes a `default` store plus per-domain overrides, and `getStore(name)`
returns the resolved domain store, so a domain override must be a **domain storage**
(`jobsStore.stores.schedules`), not a whole `LibSQLStore`. Composite `init()` initializes the
default store and then any override domain store, so each file gets only the tables its domains
need. Verify before upgrading: the `domains` override and `DOMAIN_KEYS` list are the API surface
this depends on.

## `Agent` constructor

Required: `id`, `name`, `instructions`, **`model`**.

Optional: `tools`, `workspace`, `memory`, `description`, `durable`.

Two traps:

- **`model` is required.** Omitting it throws at construction. Papyrus resolves
  the active durable profile from its customer model gateway. Existing
  deployments can bootstrap that profile from `PAPYRUS_AGENT_MODEL` plus
  `PAPYRUS_MODEL_BASE_URL` and `PAPYRUS_MODEL_CREDENTIAL_REF`; the Models tab
  and the `configureModelGateway` tool are the normal configuration paths.
  Profiles use Mastra's registered custom-gateway model shape
  `papyrus/<profile-id>/<model>`, so agent code does not change when a customer
  moves between OpenAI-compatible, Azure, Ollama, or another approved endpoint.
- **`memory` expects a `MastraMemory`, not a store.** Papyrus constructs
  `Memory({ storage })`, passes that to the agent, and also attaches the same
  `LibSQLStore` to `new Mastra({ storage })`.

## Goals

A goal is a durable, thread-scoped objective the agent keeps working toward: the agentic loop
stops, an LLM-as-judge scores the result against the objective, and an unsatisfied verdict injects
its reason as the next instruction instead of ending the turn. Papyrus sets it on the agent as
`goal: { judge, maxRuns, prompt, tools }` (`apps/server/src/agent/mastra/runtime.ts`) and gives the
agent `setGoal`, `getGoal`, and `clearGoal` to manage the objective.

Four behaviours this depends on, all verified against `@mastra/core@1.63.2`:

- **The judge is the activation switch.** With no judge model resolvable — neither per-objective
  nor in the agent config — the goal step scores nothing, consumes no budget, and emits no chunk.
  Papyrus resolves the judge at evaluation time from the active model gateway, so an appliance
  with no gateway configured behaves exactly as it did before goals existed, and one that changes
  gateway gets the new model judging the same objective. Returning `undefined` is the honest
  failure mode, not an error.
- **The objective lives in thread state**, under the `threadState` domain with `type: 'goal'`, as a
  `GoalObjectiveRecord` (objective, status, `runsUsed`, `maxRuns`, `judgeModelId`, `prompt`,
  `pausedReason`, timings). It therefore survives a process restart, and it belongs to the session
  store, not to the job store.
- **`maxRuns` bounds cost, not authority.** Each evaluation is one judge call; the default is 50
  and Papyrus sets 25. Exhausting it marks the objective `paused` rather than `done`, so a paused
  goal is unfinished work an operator can see, never a silent success.
- **A `goal.prompt` replaces the built-in judge prompt entirely.** Papyrus supplies its own, which
  restates the three-way `done` / `waiting` / `continue` contract and adds what counts as evidence:
  a plan is not the work, a proposal is not an executed action, and an unverified summary is not a
  finding. Losing the `waiting` case would let the judge call an approval-blocked objective
  complete, which is the one outcome this product must never produce.

Judge verification tools are read-only inspection (`listArtifacts`, `listSkills`,
`listActionExecutors`, `terrainQuery`, `listInvestigations`, `listProposals`) so the judge can
confirm an artifact or proposal exists rather than grading prose. Session-context tools are
deliberately excluded: the judge runs outside the chat turn, so `listAgentSchedules`-style tools
would fail on a missing `papyrusThreadId` instead of verifying anything.

**Step budget trap.** `createDurableAgenticWorkflow` defaults to
`DurableAgentDefaults.MAX_STEPS` = **5**, and the durable loop's continue test is
`lastStepResult.isContinued === true && iterationCount < runMaxSteps`. Exhausting the budget ends
the run immediately: no final message, no error, no goal evaluation — because the goal step is
only consulted once the model stops on its own. Five iterations is roughly "read two PDFs", so a
real task dies mid-work and looks like the agent gave up. Papyrus passes `maxSteps: 100`
(`AGENT_MAX_STEPS`) to both `createEventedAgent` and the agent's `defaultOptions`, making the
budget a runaway guard rather than the completion bound. `state.options?.maxSteps` from the
per-call execution options overrides the workflow default, so a caller can still narrow it.

**Durable wrapper caveat.** Papyrus registers `createEventedAgent({ agent })`. Goal closures
(`judge`, `tools`, `scorer`) cannot survive serialization, so the durable goal step reads them from
the in-process run registry, which the preparation step fills from `agent.__getGoalConfig()`, with
`mastra.getAgentById(agentId).__getGoalConfig()` as the fallback. Passing `goal` to the wrapped
`Agent` constructor is therefore sufficient — but the durable goal step only evaluates iterations
where the agent signalled it was done (`lastStepResult.isContinued === false`), and skips
background-task-pending and working-memory-only iterations. A cross-process engine without the
registry slot skips goal evaluation entirely.

## AI SDK UI transport

`POST /api/agent/chat` uses `handleChatStream({ version: 'v7' })` and returns an
AI SDK UI message stream. Because Mastra Memory is enabled, the server sends only
the newest user message to the run and supplies `memory.thread` and
`memory.resource`; replaying the browser's entire history would duplicate stored
turns and can reorder tool results.

Tool output is UI data. Plugin tools return `plugin_connection_request` objects,
which the browser renders as a secure form, while `fetchUrlPreview` returns a
`url_preview` card. Credential references submit directly to the daemon and are
never copied into the follow-up model message.

The Papyrus gateway implements Mastra's custom gateway interface and resolves
credentials only at inference time. The current built-in resolver supports
`env://` references; vault, key-vault, certificate, and managed-identity URIs
fail closed until the deployment supplies its customer-specific resolver. See
[Mastra custom gateways](https://mastra.ai/models/gateways/custom-gateways#creating-a-custom-gateway)
for the underlying gateway contract and provider/model ID format.

## Webhook signals

`WebhookSignalProvider` does not mount an HTTP route or persist its in-process
subscriptions. Papyrus owns `/api/signals/:sourceId/webhook`, authenticates it
with a source-scoped token, writes the event to `agent_signal_outbox`, and drains
it through the provider. Signal-session subscriptions are reconstructed from
Mastra thread metadata after daemon restart.

## Background work and schedules

The daemon calls `mastra.startWorkers()` after registration and
`mastra.shutdown()` during graceful shutdown. This is required: storing a
schedule definition without a scheduler worker would make the Scheduled UI
look functional while nothing ever fires. Background tasks run in the
single-daemon `full` mode with bounded global/per-agent concurrency. The URL
preview tool opts into background execution with a 15-second timeout and one
retry; configuration and action-suggestion tools remain foreground operations.

## `Workspace`, AgentFS, and nono

Papyrus now supplies its own Mastra providers instead of constructing
`LocalSandbox`:

```ts
new Workspace({
  id: 'papyrus-workspace',
  filesystem: papyrusAgentFS,
  sandbox: nonoWorkspaceSandbox,
  autoSync: false,
})
```

`PapyrusAgentFSFilesystem extends MastraFilesystem` and persists the workspace
to a local AgentFS SQLite database. The provider deliberately does **not**
configure Turso sync, so the filesystem remains usable in disconnected
deployments.

`NonoWorkspaceSandbox extends MastraSandbox`. Its
`NonoProcessManager extends SandboxProcessManager` and returns Papyrus
`ProcessHandle` implementations with streaming stdout/stderr, stdin, timeout,
kill, and process listing support. A command is executed through this chain:

```text
AgentFS materializeForExecution()  ->  real workspace directory
  node workspace-nono-worker.js <control.json>
    nono-ts CapabilitySet.apply()  (Landlock on Linux, Seatbelt on macOS)
      /bin/sh -c <command>
  AgentFS reconcileExecution()
```

Nothing is mounted. AgentFS materializes the workspace into a real directory for
the lifetime of the command and reconciles the changes back into its SQLite
database when the process exits, which is why neither FUSE nor a mount daemon is
involved on any platform. `nono-ts` then confines the process to that directory,
grants read-only access only to the provisioned toolchain paths, and grants no
network access. Credential-like environment variables are removed before child
process spawn.

This design is intentionally different from Mastra `LocalSandbox`: there is
no `isolation: 'none'` state and no host-shell fallback. If `nono-ts` reports the
platform unsupported, or its capability set cannot be applied, workspace
execution fails rather than running the requested command directly on the host.

`PAPYRUS_SANDBOX_RUNTIME=bwrap|seatbelt` is retained only for compatibility
with the earlier LocalSandbox policy module, which no production path imports;
the active Mastra workspace does not use it.

## `sendSignal` — the one that is easy to get wrong

```ts
sendSignal<OUTPUT>(
  signal: AgentSignal,
  target: SendAgentSignalOptions<OUTPUT>,
): SendAgentSignalResult<OUTPUT>
```

**Two positional arguments.** A single merged object is silently wrong.

- `signal` (`AgentSignal`) needs `type` and `contents`. `type` is a delivery
  category — `'user' | 'state' | 'reactive' | 'notification'`, plus the legacy
  `'user-message' | 'system-reminder'` — **not** an arbitrary domain string.
  `contents` is `string | Array<TextPart | FilePart>`. Use `tagName` and
  `attributes` to carry Papyrus's own event type.
- `target` is a union: `{ runId: string, ... }` **or**
  `{ resourceId: string, threadId: string, ... }`. Addressing a thread by id
  alone is not enough — it needs `resourceId` too. Papyrus derives this from the
  Entra tenant, since Entra is authoritative and a deployment serves one tenant.
- The result has an **`accepted` promise**, and it matters. It resolves to
  `wake | deliver | persist | discard | blocked`.

Only `wake`, `deliver`, and `persist` mean the agent will actually see the signal.
`discard` and `blocked` mean it will not. Acknowledging an outbox row on those
would delete evidence that was never delivered — the exact failure the outbox
exists to prevent — so `runtime.ts` throws instead and lets the row retry.
`persist` additionally exposes a `persisted` promise that should be awaited
before acking.

Papyrus sends Papyrus domain events (`new_claim`, `approval_decision`, …) as
`type: 'notification'` with the domain event in `tagName`, because these are
external events handed to the agent rather than user turns or state updates.
