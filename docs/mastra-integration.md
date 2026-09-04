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
agentfs exec --backend <fuse|nfs> <db>
  nono run --allow-cwd --block-net --
    /bin/sh -lc <command>
```

AgentFS uses FUSE on Linux and NFS on macOS for the transient command mount.
nono then applies Landlock on Linux or Seatbelt on macOS and denies network
access. Credential-like environment variables are removed before child process
spawn.

This design is intentionally different from Mastra `LocalSandbox`: there is
no `isolation: 'none'` state and no host-shell fallback. If AgentFS cannot
mount or nono is missing, workspace execution fails rather than running the
requested command directly on the host.

`PAPYRUS_SANDBOX_RUNTIME=bwrap|seatbelt` is retained only for compatibility
with the earlier LocalSandbox policy module; the active Mastra workspace does
not use it.

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
