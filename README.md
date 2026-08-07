# papyrus

The secure product development canvas for regulated industries and public sector.

Papyrus is a local-first, multiplayer product-development workspace for teams
operating in regulated and classified environments (commercial, NIPRNet/IL4,
SIPRNet/IL6). A typed, directed **canvas** of product artifacts (Discovery →
Strategy → Design → Engineering → Validation → Transition) is synchronized by an
eventually-consistent peer-to-peer layer, with **AI Skills** (Mastra agents)
that consume upstream artifacts and produce new ones — under human review.

## Architecture (in one picture)

```
papyrus CLI ──projects open──▶ Papyrus Daemon (per-user)
                                 ├─ p2panda-ffi (Node) → CRDT store, iroh/QUIC mesh, p2panda-auth
                                 ├─ Mastra server (agents/workflows; OpenAI-compatible endpoint)
                                 ├─ REST + WS API (canvas ops + presence)
                                 └─ serves Vite/React + ReactFlow SPA → browser
                                       avatars, per-node traces, neobrutalist UI
```

- **Identity (profile-gated):** SIPRNet → CAC/PIV only · IL4 → CAC/PIV + FIDO2 · commercial → FIDO2/WebAuthn + OIDC/SAML.
- **Licensing:** offline, signed, profile-bound.
- **Sync:** append-only CRDT logs (sneernet/CDS-friendly by design; transfer UI deferred).

## Monorepo

| Package | Role |
| --- | --- |
| `packages/core` | Shared types: node registry + catalog, profile config, design tokens. |
| `packages/p2panda-node` | Store/Sync port + in-memory CRDT mock (real `p2panda-ffi` adapter next). |
| `packages/cli` | `papyrus` CLI (citty): license, projects, skills, artifacts, assets, orgs, org-roles. |
| `packages/daemon` | Local per-user daemon (HTTP/WS + Mastra + p2panda). |
| `packages/agents` | Mastra agents/workflows backing AI Skill nodes. |
| `packages/web` | Vite + React + ReactFlow canvas (neobrutalist). |

## Develop

```bash
pnpm install
pnpm cli <command>      # run the CLI
pnpm smoke              # two-peer CRDT sync smoke test
pnpm typecheck          # tsc --noEmit across packages
pnpm lint               # biome
```

> Status: P0 (skeleton + riskiest-seam proof). Not production. Not a committable product yet.
