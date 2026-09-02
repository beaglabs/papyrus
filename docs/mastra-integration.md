# Mastra integration notes

Verified by reading the published `@mastra/core` **1.63.2** type declarations, not by
inference. Re-check these against the installed version before relying on them —
the export surface has moved between Mastra releases, which is why `runtime.ts`
imports the harness dynamically and feature-detects everything.

Nothing here requires Mastra to be installed. To re-verify without touching the
workspace's dependency tree:

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
| `LocalSandbox`, `LocalSandboxOptions` | `@mastra/core/workspace` | |
| `Workspace`, `WorkspaceConfig` | `@mastra/core/workspace` | There is no `@mastra/core/sandbox` subpath; sandbox types live under `workspace` |

## `Agent` constructor

Required: `id`, `name`, `instructions`, **`model`**.

Optional: `tools`, `workspace`, `memory`, `description`, `durable`.

Two traps:

- **`model` is required.** Omitting it throws at construction. Papyrus reads
  `PAPYRUS_INVESTIGATION_MODEL` and, when it is unset, does not build an agent at
  all — signals accumulate in the outbox instead. Choosing a model is the
  customer's decision; `disconnected` and `restricted` profiles cannot reach a
  hosted provider, so there is no sensible default.
- **`memory` expects a `MastraMemory`, not a store.** Passing a `LibSQLStore`
  there is wrong. Storage belongs on the `Mastra` instance
  (`new Mastra({ storage })`), which is what gives threads durability.

## `Workspace` and `LocalSandbox`

```ts
new Workspace({ sandbox: new LocalSandbox(options) })
```

`LocalSandboxOptions.isolation` is `IsolationBackend = 'none' | 'seatbelt' | 'bwrap'`.
**The default is `'none'`**, which means commands run as the host process against
the host filesystem — effectively no isolation. Papyrus never constructs one in
that state; see `sandbox-policy.ts`, which returns `undefined` unless Bubblewrap
is actually available.

`sandbox-policy.ts` is Linux/Bubblewrap-only. macOS is excluded because its only
native mechanism is Seatbelt (`sandbox-exec`), which Apple has deprecated.
`LocalSandbox` does support background processes, unlike `AppleContainerSandbox`,
which also requires Apple silicon and macOS 26+.

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
