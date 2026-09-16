# 2. Storage domains: sessions, jobs, and traces get separate files

- Status: Accepted
- Date: 2026-09-14

## Context

One `LibSQLStore` on `<data-dir>/mastra.db` backed every Mastra storage domain: session
threads and messages, schedules, workflow definitions and snapshots, background tasks,
observability traces and logs, skills, knowledge, MCP clients, and more.

That made three different lifecycles share one file and one retention boundary:

- **Session memory** is operator-visible and gets deleted. `deleteSession` removes the
  thread (`apps/server/src/agent/mastra/runtime.ts`).
- **Schedules and background tasks** are work that outlives the conversation that created
  them. A schedule is customer-meaningful recurring work, and Links bind to one
  (`boundSchedule` in the published snapshot).
- **Trace spans** grow fastest of anything the daemon writes and are retained on a
  different clock than anything an operator reads.

The cost was measurable rather than theoretical: in the local data directory, `mastra.db`
held **45.9 MiB for one thread and nine messages** — 837 spans and 25 workflow snapshots.
"A session export", "prune old traces", and "keep this receipt" were all statements about
the same file.

Schedules were also owned by the thread rather than merely associated with it: `createSchedule`
requires a `threadId`, and `deleteSession` deletes the thread *first*, then deletes its
schedules best-effort, logging failures to the console and continuing. An orphaned live cron
pointing at a deleted session is possible by construction.

## Decision

1. **Split storage by lifecycle, not by vendor.** `MastraCompositeStore`
   (`@mastra/core/storage`, not re-exported from the root) composes domains across adapters:

   | File | Domains | Lifecycle |
   | --- | --- | --- |
   | `mastra.db` | every domain except the overrides | session threads and messages |
   | `jobs.db` | `schedules`, `backgroundTasks` | work that outlives the conversation |
   | `observability.db` | `observability` | traces and logs |

   Schedules and background tasks share a file because they share a lifecycle. Traces get
   their own because they are the fastest-growing writer and the least session-related.

2. **No new scheduler.** Mastra keeps firing schedules, and `mastra_schedule_triggers` keeps
   the run/outcome bookkeeping. Owning the definition in `agent.db` would mean rebuilding
   DST handling, dedupe-on-fire, and outcome history for a cleaner foreign key.

3. **No retention policy is enabled by default.** The split makes per-domain retention
   *possible*; nothing prunes yet, and nothing is retained differently than before.

4. **Degrade, don't fail.** If the installed `@mastra/core` predates composition, or a domain
   store is missing, the runtime falls back to the single `mastra.db` rather than refusing to
   start. A future upgrade cannot turn a working appliance into a non-booting one.

## Consequences

- Backups need all three files. A session-only copy does not carry the recurring work that
  outlives it. `docs/deployment.md` says so.
- Governance observability reports `observability.db`, which is where spans actually are
  (`apps/server/src/agent/mastra/runtime.ts`).
- The action ledger, integration events, and Link state were already separate from sessions
  and stay that way: they are append-only, hash-chained, Papyrus-owned rows in `agent.db`,
  and they survive with `@mastra/core` absent entirely.
- Session deletion can no longer reach job state by accident, but it still does not cancel
  running background tasks or discard workflow snapshots. That gap is unchanged by this
  decision and remains the next durability fix.
- The dependency on the composition API is recorded in `docs/mastra-integration.md`, to be
  re-verified before any Mastra upgrade.

## Open gap

`deleteSession` should become two-phase: cancel or account for in-flight background tasks and
workflow snapshots, delete schedules and verify they are gone, and only then delete the
thread. Today a swallowed schedule-deletion failure leaves a live cron with no session.
