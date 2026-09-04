# Compliance evidence

This directory contains repository-derived evidence used by Papyrus change-control guardrails.

- `contracts.manifest.json` fingerprints public contracts and agent/workspace tool surfaces.
- `ssp.md` fingerprints the security boundary and documents the invariants enforced by the repository.
- `sbom.spdx.json` is generated as SPDX 2.3 and intentionally ignored because its creation timestamp changes on each run.

These artifacts are evidence inputs for review. They are not a certification, authorization decision, or claim of complete regulatory compliance.
