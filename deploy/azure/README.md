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

Registry credentials *are* parameters, because the appliance has to pull its
image before any onboarding can happen. Use a **pull-only** credential: it is
written to `/etc/papyrus/registry.env` (mode 0600) on the appliance, and Docker
persists an equivalent copy in `/root/.docker/config.json` after the first login.

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

**There is no credential-free ACR pull without the Azure CLI.** Microsoft's
documented managed-identity flow is `az login --identity` followed by
`az acr login`, which would mean shipping the Azure CLI on the appliance. The
raw `docker login -p <AAD token>` shortcut is not supported and fails with
`unauthorized: Invalid clientid or client secret` — verified against both the
`containerregistry.azure.net` and `management.azure.com` audiences. Two ways to
avoid a stored credential instead: enable anonymous pull on a Premium registry
(Basic does not support it), or implement ACR's `/oauth2/exchange` token
exchange, which is what `az acr login` does under the hood.

## Known gaps

- **No TLS.** The onboarding flow collects a portal secret and Entra
  configuration over plain HTTP. Something must terminate TLS in front of this
  before anyone enters real values.
- **Single VM, no high availability.** Appropriate for an appliance, not for a
  multi-node deployment.
- **`Standard_B2s` is not a safe default.** It was capacity-restricted in eastus
  when this was written, and the Bsv2 family carried zero quota on the
  subscription used for validation. Confirm availability for your target region.
