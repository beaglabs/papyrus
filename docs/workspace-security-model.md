# Papyrus local workspace security model

Papyrus deliberately separates persistent files, programmable agent logic, native
processes, and consequential external actions. These are different authority
boundaries and are not interchangeable.

```text
Agent runtime
      |
      +-- ordinary file operations ------------> AgentFS SDK
      |
      +-- multi-step generated logic ----------> Enclave STRICT
      |                                             |
      |                                             +-- brokered workspace tools
      |                                             +-- brokered process tools
      |
      +-- native document/media execution ------> constrained executor
                                                    |
                                                    v
                                              nono-ts worker
                                         Landlock / Seatbelt
                                                    |
                                                    v
                                              native program

External side effect
      |
      v
suggestAction -> human approval -> action ledger -> ActionExecutor
```

## AgentFS: durable workspace

The Mastra `WorkspaceFilesystem` is implemented directly with `agentfs-sdk`.
The database is local SQLite storage beneath `PAPYRUS_DATA_DIR`; no AgentFS
CLI, mount daemon, Turso account, or external storage service is required.

The important directories are:

- `/Library/Uploads` — operator attachments; treated as input.
- `/Library/Generated` — generated deliverables.
- `/Workspace` — mutable local working files.

Agent Chat Library search, uploads, `@` references, and workspace filesystem
tools operate directly on AgentFS without materializing files onto the host.

## Enclave: programmable logic, not host authority

AI-generated multi-step JavaScript is executed through
`@enclave-vm/core@2.15.2` in `STRICT` mode with:

- AgentScript AST validation and transformation;
- no Node built-ins;
- bounded execution time, iterations, memory tracking, console output, and
  tool calls;
- sanitized errors;
- rule-based scoring;
- a bounded reference sidecar.

Papyrus does not run Enclave inside the daemon. Enclave has historically had
sandbox-escape vulnerabilities, including CVE-2026-27597 in versions through
2.10.1. Papyrus pins a patched version and also treats Enclave as only one
layer of defense.

Every AgentScript program runs in a dedicated child process which applies
`nono-ts` before executing untrusted code. If a future Enclave escape reaches
the worker's host JavaScript realm, it is still inside the kernel sandbox with
network access denied and without the Papyrus daemon's environment, AgentFS
database, or credentials.

The Enclave worker cannot directly touch AgentFS. It can only request these
Papyrus-brokered capabilities:

```text
workspace:list
workspace:stat
workspace:readText
workspace:writeText
process:python
process:pandoc
process:libreoffice
process:ffmpeg
process:remotion
```

Unknown tool names fail closed.

## Native processes: constrained executors

Papyrus does not attach its process sandbox to Mastra's generic Workspace
surface. This prevents the agent from acquiring a general-purpose shell tool.

Native programs are exposed as structured tools with fixed executables and
validated arguments:

- `runPythonScript`
- `convertWithPandoc`
- `convertWithLibreOffice`
- `renderWithFfmpeg`
- `renderRemotion`

The model cannot select an arbitrary executable through these tools. Generated
outputs are restricted to `/Workspace` or `/Library/Generated`.

Before native execution, Papyrus creates a bounded private materialization of
AgentFS. A dedicated worker applies `nono-ts` and then launches the command.
Outbound network is blocked. After exit, Papyrus rejects symlinks and
unsupported file types, bounds the resulting tree, reconciles allowed changes
back into AgentFS, and removes the temporary host directory.

Executions are serialized against the workspace snapshot/reconciliation phase
to avoid lost-update races.

## Why both Enclave and nono

They protect different layers:

| Boundary | Responsibility |
| --- | --- |
| AgentFS | durable local file authority |
| Enclave | safe generated AgentScript and explicit capability brokering |
| Papyrus constrained executors | fixed native operations and argument policy |
| nono-ts | kernel-enforced native process isolation |
| Papyrus action ledger | human-authorized external side effects |

Enclave does not replace the OS process sandbox, and nono does not replace the
AgentScript capability broker.

## External actions remain separate

Workspace execution never grants action authority. Sending email, changing
firewall state, disabling an account, publishing into an external system, or
performing another consequential action must still cross the normal Papyrus
proposal, human approval, ledger, and ActionExecutor boundary.
