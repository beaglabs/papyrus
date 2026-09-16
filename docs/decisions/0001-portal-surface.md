# 1. Portal surface: session-scoped status, no top-level catalog pages

- Status: Accepted
- Date: 2026-09-14

## Context

The portal exposes five views, and only five: `agent`, `models`, `links`, `library`,
`governance` (`apps/web/src/App.tsx`).

Mastra owns sessions, memory, schedules, workflows, and signal delivery. The integration
catalog, its governed lifecycle, the sync worker, and the action ledger all live in the
daemon (`apps/server/src/agent/catalog.ts`, `service.ts`, `sync-worker.ts`, `action-store.ts`).

A previous direction added top-level surfaces for plugins, schedules, and workflows, plus a
full `/api/integrations/*` HTTP API. Those surfaces were deliberately pruned:

- `apps/web/src/App.test.tsx` asserts the portal renders none of
  `terrain | investigation | workflows | plugins | scheduled`.
- The agent's own instructions state "There is no Plugin catalog or scheduler page"
  (`apps/server/src/agent/mastra/runtime.ts`).
- `apps/server/tests/agent-http.test.ts` asserts `/api/plugins`, `/api/schedules`,
  `/api/signals/legacy/webhook`, and every `/api/integrations/*` route return **404**.

Two capabilities nonetheless remain real and session-scoped: recurring work
(`listAgentSchedules` / `createAgentSchedule` / `deleteAgentSchedule`, each gated by
`assertOwnedThread`) and in-flight background tasks (`backgroundTasks` with
`fetchUrlPreview`, `readDeviceConsolePage`, `renderDeviceConsolePage`). Operators currently
have no way to see either one outside a single chat card.

## Decision

1. **No top-level catalog pages.** The portal keeps exactly five views. Schedules,
   workflows, plugins, and the integration catalog do not get routes of their own.
   `/api/schedules`, `/api/plugins`, and `/api/integrations/*` are not restored.

2. **Recurring work and running jobs are surfaced as live status, not as a management
   surface.** They appear in the sidebar footer, scoped to the current session/thread.
   Cross-session visibility is out of scope and would require its own role decision.

3. **Integration configuration stays conversational.** The agent manages it through tools
   inside a session. The action boundary remains the one deliberate portal surface:
   proposals, approvals, and receipts are visible in the agent and governance views.

4. **Authority is unchanged.** Activating a `controlled_actions` connector still requires
   `Papyrus.Security.Manage`, and writes still cross propose → approve → receipt. Nothing in
   this decision widens what the agent may do.

## Consequences

- The "no pruned surfaces" guard in `apps/web/src/App.test.tsx` needs **no amendment**. It
  asserts on the buttons rendered by `PrimaryNavigation` only, so it already forbids
  top-level navigation entries for those surfaces while leaving the footer free. The footer
  strip lives outside that guard and is covered by its own tests in the same file, which
  assert the runtime line renders without a scoped session and that an unobservable job
  queue says so rather than reporting zero.
- `README.md` and `docs/integrations.md` must stop describing `/portal/plugins`,
  `/portal/scheduled`, `/portal/workflows`, `/portal/integrations`, and the
  `/api/integrations/*` endpoints as available surfaces.
- The integration catalog stays server-side only until a conversational configuration tool
  exists.

## Open gap

The conversational integration configuration tool does not exist. `INTEGRATION_CATALOG` is
referenced only by `service.ts`, and no per-catalog-entry agent tool is generated. The claim
that "a generated tool exists for every catalog entry" was inaccurate and has been removed
from the README. Implementing it — or explicitly deciding that integrations remain
server-side only — is tracked as follow-up work.
