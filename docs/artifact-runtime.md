# Orchestrated artifact runtime

Papyrus uses one project conversation. `routeAgentRequest` selects a primary specialist from the request, honors explicit `@persona` mentions, and returns the invited specialists as routing metadata. The UI persists this conversation under the `orchestrator` session while each canvas node records its actual producing persona.

All generated deliverables use `papyrus.artifact/v1`. The envelope separates the artifact's semantic kind from its renderer, payload, files, lineage, and permissions. Legacy USWDS wireframes are adapted automatically, and malformed or unknown deliverables fall back to a readable JSON or Markdown artifact instead of disappearing.

Current renderers are:

- `uswds-wireframe` for `papyrus.uswds-wireframe/v1`
- `openapi` for endpoint summaries
- `code` and `web-preview` for isolated Sandpack workspaces
- `security` for security findings and control evidence
- `json` and `markdown` as universal fallbacks

Artifacts declare network and credential requirements; they never contain credential values. A future tool broker can exchange those declarations for opaque, revocable credential handles supplied by a host-owned authorization dialog. Model prompts and canvas documents must only receive the handle and approved scope, never the secret.

Renderer selection is registry-based and is intentionally independent of persona. Any specialist can emit any artifact kind when the orchestration route requires it.
