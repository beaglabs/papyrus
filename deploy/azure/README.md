# Papyrus on Azure

The technical asset behind the Azure Application offer. One deployment produces a
working appliance: a stock Ubuntu 24.04 VM running the container built from the
repo `Dockerfile`, supervised by systemd, with a dedicated data disk for state.

This template is the *content* of the offer. Choosing between a **solution
template** plan and a **managed application** plan is packaging, not content —
both consume the same Bicep.

```
deploy/azure/
  main.bicep                      # VM, network, data disk, cloud-init
  cloud-init.yaml                 # host bootstrap; placeholders filled in by main.bicep
  main.example.parameters.json    # copy and fill in
```

## Deploy

```sh
az deployment group create \
  --resource-group <your-rg> \
  --template-file main.bicep \
  --parameters main.example.parameters.json
```

Outputs include the appliance name, public IP, onboarding URL, and SSH command.
The onboarding flow prints its setup token to the container log:

```sh
az vm run-command invoke -g <rg> -n papyrus-appliance \
  --command-id RunShellScript --scripts "docker logs papyrus 2>&1 | head"
```

## What is deliberately not a parameter

Papyrus's own secrets — the setup token, license, portal secret, and Entra
configuration — are entered through the first-run onboarding flow and are never
template parameters. That keeps them out of ARM deployment history.

**Neither is the container image.** The repository is publicly pullable, so the
deployment carries no registry credential at all. The image reference is a single
variable in `main.bicep` (`imageReference`) rather than a parameter: customers do
not choose the image, and asking them for a pull credential would put a secret in
a field they have no business holding.

That is the only option that works. Every alternative was considered and rejected:

- **Embedding a credential** — impossible. A solution template's ARM JSON is
  visible to every customer, and its deployment history is readable by anyone
  with access to the resource group.
- **Managed identity with an AcrPull grant** — the customer's VM identity lives in
  their tenant and the publisher's registry in ours. Azure RBAC does not span
  tenants, so this cannot reach a publisher-owned registry.
- **Gating the pull to "whoever deployed the offer"** — not a control. Deploying a
  listed offer is free and self-service, so any gate keyed on it is satisfied by
  anyone motivated to get past it.

The consequence to accept deliberately: the image is inspectable by anyone. For
this product that is acceptable. The customer already has root on the appliance,
so the image was never secret from them, and what the licence protects is the
commercial entitlement rather than the bytes. It does mean **no dev data may ever
be baked into the image** — see the runtime data directories excluded in
`.dockerignore`, which were added after a scan of the built image found a private
key and the local development databases inside it.

## Validated configuration

Validated end to end on `linux/amd64`:

| | |
|---|---|
| Image | built natively by ACR Tasks, `AMD64` / `linux` |
| Host | Ubuntu 24.04.4 LTS, kernel `6.17.0-1022-azure` |
| Sandbox | `landlock` active in the kernel LSM list |
| Container | healthy, `node /healthcheck.mjs` exits 0 **under Docker's default seccomp profile** |
| Data disk | NVMe, mounted at `/var/lib/papyrus`, owned by uid 65532 |

Changing any of these invalidates the result and needs a re-test:

- **seccomp or capability options.** `cloud-init.yaml` intentionally runs the
  container with no extra hardening flags, because that is the configuration the
  sandbox was validated against. Landlock needs syscalls that are permitted by
  Docker's default profile.
- **`securityType`.** Defaults to `Standard` to match the validated VM.
  `TrustedLaunch` is the better production posture but changes the boot chain,
  so validate before relying on it.

## Two gotchas worth knowing

**Data disk device paths differ by VM size.** SCSI-attached disks appear under
`/dev/disk/azure/scsi1/lun<N>`; NVMe-attached disks (newer sizes such as
`Standard_D2as_v7`) appear as `/dev/disk/azure/data/by-lun/<N>`. Assuming only
the SCSI path silently leaves the data disk unattached. `papyrus-data-disk.sh`
tries both and falls back to the one whole disk that is neither mounted nor
partitioned.

**The image must be publicly pullable, and this was not the first choice.** The
obvious approach — the appliance using the VM's managed identity to pull from an
Azure Container Registry — does not work, and it is worth recording why so nobody
retries it:

- Microsoft's documented managed-identity flow is `az login --identity` followed
  by `az acr login`, which would mean shipping the entire Azure CLI on the
  appliance.
- The raw `docker login -p <AAD token>` shortcut is not a supported flow. It fails
  with `unauthorized: Invalid clientid or client secret`, verified against both
  the `containerregistry.azure.net` and `management.azure.com` audiences.
- Even had it worked, the grant cannot span tenants, so it could not have reached
  a publisher-owned registry from a customer subscription anyway.

So the image is published publicly to GHCR:

```
ghcr.io/beaglabs/papyrus:0.1.1
```

Verified anonymously pullable — logged out of the registry, removed the local tag, and
pulled it clean at digest `sha256:a1cd6990d2a9…`. It is **amd64**, built natively by ACR
Tasks with no emulation, and scanned clean of the development data described above.

Tags are immutable here: ship a new tag per change and update `imageReference`, rather than
overwriting a published one. `0.1.0` remains pullable but predates the onboarding fix.

Two things that cost time and are worth not rediscovering:

- **The build must be amd64.** Building locally on an Apple Silicon machine produces
  `linux/arm64`, which an amd64 appliance VM cannot run — it fails with `exec format
  error` after a successful push. Build with `az acr build` so it is native, then promote
  the result.
- **GitHub disables public packages by default.** Until it is enabled at **Organization
  settings → Packages**, package visibility cannot be changed through the UI or the API,
  and the anonymous pull fails with `unauthorized`. Note that the REST endpoint for org
  package settings returns a flat 404 for both "no permission" and "not allowed", so it
  cannot distinguish them — the organisation settings page is the only place that says
  which it is.

The outbound-internet requirement below is unchanged either way.

## Known gaps

- **No TLS.** The onboarding flow collects a portal secret and Entra
  configuration over plain HTTP. Something must terminate TLS in front of this
  before anyone enters real values.
- **Single VM, no high availability.** Appropriate for an appliance, not for a
  multi-node deployment.
- **`Standard_B2s` is not a safe default.** It was capacity-restricted in eastus
  when this was written, and the Bsv2 family carried zero quota on the
  subscription used for validation. Confirm availability for your target region.
