# Papyrus contracts

The repository-level `contracts` workspace is the single source of truth for shared Papyrus types and plugin conformance contracts.

- `src/` contains the shared application contracts consumed through `@papyrus/contracts`.
- `plugins/` contains exactly one typed contract per plugin plus the public registry.
- `tests/` is the deterministic conformance harness. Replay fixtures are sanitized and credential-free.
- `../acp-runtime/` contains the ACP runtime contract package.

## Adding or changing a plugin

1. Add or update `contracts/plugins/<plugin-id>.ts`.
2. Register it in `contracts/plugins/index.ts`.
3. Add replay fixtures for every replay-required schema.
4. Run `pnpm contracts:test`.
5. Regenerate compliance evidence with `pnpm compliance:generate` when contract fingerprints change.

The pre-commit hook runs the full contract conformance harness. Contract files, registry membership, security invariants, schema fixture coverage, workspace layout, and ACP runtime exports therefore fail closed before a commit is accepted.
