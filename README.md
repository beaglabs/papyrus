# Papyrus

Papyrus is a secure, self-hosted agent gateway for regulated and disconnected environments.

This branch is a clean-slate pivot. It intentionally contains none of the previous canvas, built-in agent, workflow-pack, transfer, browser, or daemon implementation. Papyrus will provide the branded web experience and the security control plane around Goose, connected through the Agent Client Protocol (ACP).

## Product boundary

Papyrus owns:

- the Papyrus web UI and branding;
- identity, authorization, resource assignment, session ownership, audit, and licensing;
- the policy-enforced boundary for model and MCP/tool access;
- lifecycle management for a pinned Goose runtime distribution; and
- local and persistent single-deployment operating modes.

Goose owns the agent loop. Papyrus does not implement another agent harness, host foundation models, or expose ungoverned MCP connections.

## Initial release

The first release is limited to:

1. Papyrus web UI and branding
2. Commercial OIDC
3. Government CAC/mTLS
4. Fixed initial roles
5. Cedar enforcement
6. Workspace and runtime assignments
7. Session ownership
8. Tool/MCP permissions
9. Append-only audit events
10. Goose as the only runtime
11. Local and persistent server modes
12. Signed offline licensing

The exact boundaries and acceptance criteria are in [docs/product-scope.md](docs/product-scope.md).

## Deferred

The first release will not include customer-authored Cedar policies, additional ACP runtimes, automated cross-domain transfer, complex organization hierarchies, workflow building, an agent marketplace, or multitenant SaaS administration.

## Planned repository shape

- apps/web — branded browser UI
- apps/server — API, identity boundary, policy enforcement, persistence, audit, and runtime supervision
- packages/contracts — versioned API and event contracts shared by the server and UI
- packages/goose-runtime — the only ACP runtime adapter in the initial release

Security-sensitive modules stay inside the server instead of being split into many premature packages. Additional boundaries will be extracted only when they have an independent consumer.

## Status

Architecture baseline only. This branch is not production-ready, accredited, or authorized for classified information.
