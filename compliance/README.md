# Compliance artifacts

Papyrus generates repository-derived compliance evidence here. These files support engineering review and audit preparation; they are not themselves a certification, authorization decision, or complete regulatory submission.

- `ssp.md` — generated system-security-plan summary plus Git blob fingerprints for the security boundary. This file is tracked and must be reviewed/staged when guardrail-relevant code changes.
- `contracts.manifest.json` — generated fingerprint and exported-symbol snapshot for the shared application contracts and ACP runtime contract. This file is tracked and enforces contract/schema drift checks.
- `sbom.spdx.json` — generated SPDX 2.3 source SBOM from the staged pnpm lockfile and workspace package manifests. It is intentionally ignored because its creation timestamp changes on each generation; CI regenerates it for every verification run.

Use `pnpm compliance:generate` to regenerate all artifacts. `pnpm compliance:check` verifies the tracked SSP/contract evidence without overwriting it and emits the ignored SBOM for CI artifact upload.
