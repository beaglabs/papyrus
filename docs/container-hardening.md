# Hardened container

Papyrus uses the Minimus Node 24 FIPS development image only to build and the
distroless production image to run. Both references pin the `v24.19.0` OCI
index digest. The runtime contains the compiled server and production
dependencies; source, tests, declarations, source maps, package managers, and
build tools are removed.

The container entrypoint fails before loading the server unless
`crypto.getFips() === 1`. It runs as UID/GID 1000. The Kubernetes example also
requires a read-only root filesystem, the runtime-default seccomp profile,
disabled privilege escalation, no service-account token, and all Linux
capabilities dropped. Only `/var/lib/papyrus` and a bounded `/tmp` are writable.

Secrets are injected at deployment time. They are never Docker build arguments,
image environment defaults, or Kubernetes literal values. Replace the example
application image placeholder with the immutable digest produced by CI.

The container workflow builds and verifies the image, emits a CycloneDX SBOM,
fails on fixable high or critical vulnerabilities, uploads SARIF, and on `main`
publishes a commit-addressed image, signs it keylessly, and creates GitHub build
provenance.
