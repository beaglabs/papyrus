# 3. Agent goals: the judge gates completion

- Status: Accepted
- Date: 2026-09-14

## Context

The agent stopped when the model stopped. For a question that is right; for an objective that
takes several steps it means the operator gets a plan, a partial result, or a "should work", and
has to keep prompting to get the work finished. Instructions alone did not fix it: an agent that
believes it is done has no reason to continue, and Papyrus had no mechanism that could tell it
otherwise.

Mastra's goals close that loop. A goal is a durable, thread-scoped objective; when the agent
would otherwise end its turn, an LLM-as-judge scores the result against the objective, and an
unsatisfied verdict injects its reason as the next instruction rather than ending the run.

## Decision

1. **The goal step is on, with the active gateway model as judge.** `goal` is configured on the
   agent with a judge resolver that reads the active model gateway at evaluation time, so
   switching gateways in the portal changes the judge without a restart. The judge is the
   activation switch: when no model is configured the resolver returns `undefined` and the goal
   step is a no-op, which keeps an unconfigured appliance behaving exactly as before.

2. **The agent decides when an objective is warranted, through tools.** `setGoal`, `getGoal`, and
   `clearGoal` write and read the objective; the agent is instructed to set one for any request
   that takes more than one step or must be finished rather than started. Papyrus does not open a
   goal automatically on every turn, because most turns are questions and a goal per question is
   a judge call per question.

3. **The agent can never mark its own goal done.** Only the judge closes an objective. `clearGoal`
   exists for the operator changing or abandoning the objective, and the instructions say so
   explicitly. Completion is otherwise not something the agent can assert.

4. **Cost is bounded at 25 judge evaluations by default**, settable per objective up to 100.
   Exhausting the budget marks the objective `paused`, never `done`, so unfinished work stays
   visible instead of being reported as success.

5. **The judge gets read-only verification tools** — artifacts, skills, executors, terrain, and the
   action ledger — so it can check that the artifact or proposal exists instead of grading prose.
   This adds no authority: every one of those tools is read-only, and approval and execution remain
   human actions against the ledger.

6. **The judge prompt is Papyrus's own, and restates the three-way contract.** Supplying
   `goal.prompt` replaces Mastra's built-in prompt entirely, so Papyrus re-states `done` /
   `waiting` / `continue` and adds what counts as evidence. The `waiting` case matters most: many
   objectives end at an approval the agent is forbidden to grant itself, and a judge that called
   that `done` would report work the ledger has not released.

## Consequences

- Goals are durable session state: the objective is a row in `thread_state` (`type: 'goal'`) in
  `mastra.db`, so it survives a restart and is a session-lifecycle artifact, not a job-store one.
  This is the opposite call from ADR 0002 for a reason: a goal is scoped to a conversation, and
  the conversation ending should end it, while a schedule deliberately outlives its thread.
- The footer status strip reports the active objective and its judge budget, so an operator can
  see work in progress rather than inferring it from the transcript.
- Every goal evaluation is a model call. A customer who sets long-running objectives is choosing
  to spend tokens on verification, and `maxRuns` is the dial.
- Goals require `@mastra/core` storage and a memory-backed thread; with the agent unregistered,
  the tools report `AGENT_GOAL_UNAVAILABLE` rather than pretending to have set an objective.

## Open gap

The judge defaults to the same model the agent runs, which means the agent is graded by a model
with the same blind spots. A customer-configurable judge profile — ideally a different, cheaper
model — is the next step, and `goal.judge` is already resolver-shaped to accept it. There is also
no operator-facing way to see *why* a goal paused beyond `pausedReason` on the record; a portal
surface for goals is deliberately not in this decision, matching ADR 0001's rejection of
top-level management pages.
