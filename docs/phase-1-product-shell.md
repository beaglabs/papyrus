# Phase 1: product shell and run protocol

This branch pivots Papyrus from a code-canvas-first product toward a governed agent-work platform without prematurely adding the execution dependencies owned by later phases.

## Delivered

- Persistent Work, Intake, Agents, Skills, Connections, and Admin navigation
- Official classification and local-runtime indicators
- A 34/66 conversation-to-workbench split that reserves substantially more room for browser and tool sessions
- Versioned browser-safe contracts for runs, events, tool sessions, and human approvals
- Explicit-run behavior: opening a project no longer turns its brief into an automatic model execution
- Existing auth, projects, collaboration, artifacts, licensing, and code-preview functionality retained

## Phase boundaries

Phase 2 implements durable LangGraph execution against these contracts.
Phase 3 replaces the generic preview with managed Stagehand tool sessions.
Phase 4 implements controlled intake and release.
Phase 5 adds the CAPE workflow pack.

The current Sandpack code workbench remains available during the transition and becomes an optional software-development capability later.
