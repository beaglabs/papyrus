# Artifact and Skill Runtime

Papyrus separates **local workspace capability** from **external operational authority**.

## Capability boundary

Creating or editing a file inside the customer-hosted runtime is not an action-executor operation. Artifact work uses the local artifact/workspace path:

```text
Agent runtime
      |
      +-- listSkills / loadSkill
      |
      +-- createArtifact --------> durable artifact metadata/card
      |                              + /Library/Generated/<name> in AgentFS
      |
      +-- sandbox workspace
              |
              +-- publishArtifact -> durable artifact store
```

External side effects remain behind the action ledger:

```text
artifact -> suggestAction -> human approval -> action ledger -> executor
```

For example, creating `incident-report.pdf` requires no action approval. Sending that PDF through Exchange is an external side effect and therefore requires an approved Exchange action. Approved email actions may reference durable artifacts through `parameters.artifactIds`.

## Built-in skills

The runtime advertises these enabled Papyrus skills by default:

- `pdf` — PDF generation and sandbox publication
- `docx` — Word-compatible document generation
- `xlsx` — typed multi-sheet spreadsheet generation
- `remotion` — sandboxed video/animation workflows when the local Remotion toolchain is installed
- `skill-creator` — governed creation of reusable organization skills

Built-ins are Papyrus-authored. The runtime does not vendor third-party proprietary skill text.

A skill teaches a procedure. It cannot add tools, network access, or external authority.

## Artifact tools

### `createArtifact`

Creates a durable artifact directly for deterministic document formats:

- PDF
- DOCX
- XLSX
- TXT / Markdown
- JSON
- CSV
- HTML

The tool returns a typed `kind: "artifact"` object. Agent Chat renders that object as an inline artifact card rather than asking the model to carry binary data.

### `publishArtifact`

Publishes a file that already exists inside the Mastra sandbox workspace. The implementation resolves real paths and rejects paths outside the configured sandbox root. This path is intended for richer local toolchains such as Remotion, advanced Office generation, or other customer-installed renderers.

### `listArtifacts`

Returns metadata for artifacts in the local daemon. Artifact metadata includes SHA-256, MIME type, size, preview information, and skill provenance.

Artifact bytes live under `<PAPYRUS_DATA_DIR>/artifacts` with restrictive local file permissions. Active content such as HTML and SVG is forced to download and cannot execute at the Papyrus portal origin.

## Inline Agent Chat UI

Typed artifact outputs render according to preview kind:

- PDF: embedded same-origin PDF preview
- DOCX/document: document excerpt plus open/download controls
- XLSX/spreadsheet: sheet tabs and table preview for generated workbooks
- MP4/WebM: inline video player
- images: inline image preview
- text: bounded text preview

Every card shows the content hash and, when supplied, the generating skill/version.

## Dynamic skills

`draftSkill` creates an inert `workspace_draft`. The draft is persisted as both metadata and a `SKILL.md` package beneath `<PAPYRUS_DATA_DIR>/skills`.

Requested capabilities are filtered through the Papyrus allowlist and remain requests only.

Lifecycle:

```text
workspace_draft
      |
      | Papyrus.System.Owner
      v
organization_approved + enabled
```

Only enabled skills can be loaded by the agent. Built-in skill names cannot be replaced by generated skills.

## Publishing artifacts through Exchange

The existing Exchange executor can attach durable artifacts after approval:

```json
{
  "action": "notify",
  "target": "analyst@example.mil",
  "parameters": {
    "subject": "Incident report",
    "body": "Attached is the approved report.",
    "artifactIds": ["<artifact-id>"]
  }
}
```

The executor resolves artifact bytes only after the proposal has crossed the normal approval and leased-worker boundary. Direct Graph sends are capped to a small aggregate attachment size; larger publication should use a customer upload/publishing workflow.

## AgentFS and Links

Durable artifact cards are presentation/provenance metadata; AgentFS is the workspace authority. Artifact tools return `workspacePath`, and `prepareLink` accepts that path or `artifactId`. Missing legacy mirrors are reconstructed only after SHA-256 verification.
