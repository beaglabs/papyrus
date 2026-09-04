# Artifact and Skill Runtime

Papyrus separates **local workspace capability** from **external operational authority**.

## Capability boundary

Creating or editing a file inside the customer-hosted runtime is not an action-executor operation. Artifact work uses the local artifact/workspace path:

```text
Agent / Starlings
      |
      +-- listSkills / loadSkill
      |
      +-- createArtifact --------> durable artifact metadata/card
      |                              + /Library/Generated/<name> in AgentFS
      |
      +-- sandbox / AgentFS workspace
              |
              +-- publishArtifact -> durable artifact metadata/card
                                      + canonical /Library/Generated mirror
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

Creates a durable artifact directly for deterministic document formats. The returned object includes a canonical `workspacePath`; the exact artifact bytes are SHA-256 verified and mirrored into AgentFS under `/Library/Generated` so Library, attachments, and Links all see the same content:

- PDF
- DOCX
- XLSX
- TXT / Markdown
- JSON
- CSV
- HTML

The tool returns a typed `kind: "artifact"` object. Agent Chat renders that object as an inline artifact card rather than asking the model to carry binary data.

### `publishArtifact`

Publishes a file that already exists inside the Mastra/AgentFS workspace. The durable artifact card remains available for preview/download, while Papyrus also preserves a SHA-256-verified canonical copy under `/Library/Generated`. This path is intended for richer local toolchains such as Remotion, advanced Office generation, or other customer-installed renderers.

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

The durable artifact store is presentation/provenance metadata, not a second workspace authority. Link publication always snapshots from AgentFS.

`createArtifact` and `publishArtifact` therefore return `workspacePath`. `prepareLink` accepts either that path or the durable `artifactId`. For artifacts created by an older runtime, a missing `/Library/Generated/<name>` reference is repaired from the durable artifact bytes only after their recorded SHA-256 is revalidated.

This means the supported path is:

```text
artifact generation
      -> durable artifact record
      -> SHA-256 verified AgentFS /Library/Generated mirror
      -> prepareLink snapshot
      -> human approval
      -> Link publication
```
