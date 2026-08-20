# Governed sessions

Papyrus is the authoritative owner of session identity, authorization, lifecycle,
run state, and event history. HTTP and ACP transports delegate to the same
`PapyrusService` methods.

## Lifecycle

| State | Meaning | Allowed transition |
| --- | --- | --- |
| `ready` | Accepts a prompt | prompt → `running`; close → `stopped` |
| `running` | Exactly one durable run is active | complete/cancel → `ready`; failure → `failed`; close → `stopped` |
| `failed` | The last runtime turn failed | prompt/resume → `ready` or `running`; close → `stopped` |
| `interrupted` | The daemon restarted or shut down before completion | resume/prompt → `ready` or `running`; close → `stopped` |
| `stopped` | Closed and unavailable for prompts | resume → `ready` |

A partial unique index enforces one active run per session. In-memory abort
controllers provide prompt cancellation, while durable state prevents a restart
from making an orphaned run look successful.

## Durable records

Every prompt creates a `session_runs` row and records:

- actor, session, start and completion timestamps;
- completed, cancelled, failed, or interrupted status;
- bounded failure details and the terminal stop reason;
- a cursor-addressable user-message and runtime-event stream tied to the run.

On startup, Papyrus marks any remaining running records as interrupted and emits
an append-only recovery audit event.

## HTTP API

- `POST /api/sessions/:id/prompt`
- `POST /api/sessions/:id/cancel`
- `POST /api/sessions/:id/close`
- `POST /api/sessions/:id/resume`
- `GET /api/sessions/:id/runs`
- `GET /api/sessions/:id/events?after=<sequence>&limit=<1..1000>`

Only the session owner or an authorized administrative role may operate a
session. Auditors retain read-only access.

## ACP behavior

Papyrus advertises stable `session/list`, `session/load`, `session/resume`, and
`session/close` capabilities. Baseline prompt and cancel are always supported.
`session/load` replays the durable event stream. Client-supplied provider
credentials and MCP servers are not accepted; the daemon selects the configured
runtime and exposes only workspace-governed MCP grants.

The current local stdio adapter creates an isolated runtime execution for each
prompt. Papyrus session history is durable and replayable, but runtime-native
context reuse requires an adapter that advertises and implements persistent
load/resume support.
