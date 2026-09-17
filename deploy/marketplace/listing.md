# Microsoft Marketplace listing — working plan

Target: **Azure Application offer** (solution template plan), commercial Azure only,
**free / BYOL** listing. No transact, no managed application, no metered billing.

Technical assets already exist and are validated:
`deploy/azure/main.bicep`, `cloud-init.yaml`. Still missing:
`mainTemplate.json` (compiled) and `createUiDefinition.json`.

---

## 1. Partner Center fields — checklist

### Offer level
| Field | Status |
|---|---|
| Offer ID / alias | to choose |
| Offer name | draft below |
| Search results summary (~short) | draft below |
| Description (long) | draft below |
| Publisher / legal entity | **needed from you** |
| Support URL | `https://www.beaglabs.com/support/commercial` — live. This is the URL certification checks for `100.5.1.3 Support and Help`. |
| Support email | `james@beaglabs.com` |
| Support phone | **needed from you** — there is no support line, and the page says so. If Partner Center requires a number, give the business line rather than leaving the field blank. |
| Engineering contact (name/email) | **needed from you** |
| Privacy policy URL | `https://www.beaglabs.com/privacy-policy` — live, returns 200 |
| Terms of use | `https://www.beaglabs.com/terms-of-service` — live, returns 200, or the Standard Contract for Microsoft Marketplace |
| Logo: small 48×48 | `deploy/marketplace/logos/papyrus-small-48x48.png` |
| Logo: large 216×216 | `deploy/marketplace/logos/papyrus-large-216x216.png` |
| Logo: wide 255×115 | `deploy/marketplace/logos/papyrus-wide-255x115.png` |
| Screenshots (≥1) | **needed** — can be captured from the onboarding UI |
| Videos | optional |
| Categories (pick 2) | proposed below |
| Industries | proposed below |
| Search keywords (3) | draft below |
| Help / getting-started link | `https://github.com/beaglabs/papyrus/blob/main/deploy/azure/README.md` |
| CSP channel link | `https://www.beaglabs.com/partners/csp` — live. This is the link behind `100.5.1.2 Learn More Links`. |

### Plan level
| Field | Status |
|---|---|
| Plan ID / name | draft below |
| Plan summary | draft below |
| Plan description | draft below |
| Markets | commercial only — **do not** tick Azure Government |
| Technical configuration | `mainTemplate.json` + `createUiDefinition.json` |
| Plan visibility | public |

Note: exact character limits per field differ and change — check them in Partner Center
and trim the copy below to fit rather than trusting any limit stated here.

---

## 2. Draft copy

### One-liner (search summary)
> Customer-hosted durable agent runtime. Your subscription, your identity, your model
> endpoint — no vendor cloud callback.

### Short description
> Papyrus is a customer-hosted runtime for durable, event-driven agent work. Sessions,
> goals, approvals, and scheduled workflows survive restarts and run entirely inside your
> own Azure subscription, with Microsoft Entra ID as the only identity authority, your own
> model endpoint, and a deployment-bound signed license that requires no callback to us.

### Long description

**Durable agent work, not chat.**
Papyrus runs long-horizon agent tasks that have to finish rather than merely start. A goal
is durable session state: it survives a reload, a message arriving mid-run is still judged
against it, and work resumes from where it stopped instead of restarting. Sessions, memory,
schedules, workflows, and signal delivery are owned by the runtime.

**Customer-hosted by construction.**
Everything runs in your Azure subscription. Papyrus makes no call to a vendor control
plane — the license is a signed, deployment-bound file verified offline. Nothing about your
workloads, prompts, or outputs leaves your environment.

**Identity is Entra, and only Entra.**
Portal roles are Microsoft Entra ID application roles. There is no local role database, no
invitation flow, no password store, and no provisioning side-channel to reconcile.

**The agent proposes; policy releases.**
The agent proposes actions, and deterministic workflow policy plus an Entra-authorized
approver release them. Connector configuration accepts customer-vault, certificate, or
managed-identity references — inline tokens, passwords, client secrets, and private keys
are rejected rather than stored.

**Execution is sandboxed, or it refuses to run.**
On Linux, agent code runs under **Landlock** for filesystem confinement plus **seccomp**,
launched through `landstrip`, with outbound network denied. On a host that cannot provide
isolation, execution is switched off and the daemon reports why — it does not silently fall
back to running agent code unprotected. Verified on `linux/amd64`: Landlock active in the
kernel LSM list, and the boundary probe passes under Docker's default seccomp profile.

**Bring your own model.**
Point Papyrus at any OpenAI-compatible or Azure OpenAI endpoint — including one in your own
tenant — and it registers as a model profile. Restricted and disconnected profiles refuse
to fall back to a commercial provider endpoint, so a closed environment stays closed.

**What you need.** An Azure subscription, a Microsoft Entra tenant, and a model endpoint
(Azure OpenAI, any OpenAI-compatible endpoint, or a self-hosted one). Deployment is a
single Azure Application; onboarding is a first-run flow in the portal, and the appliance
prints a setup token on first boot.

### Plan name
> Papyrus - self-deployed appliance (BYOL)

### Plan summary
> Deploys the Papyrus appliance into your own Azure subscription. Bring your own license.

*(87 characters)*

### Plan description

*(1,286 characters)*

> Deploys the Papyrus appliance into your own Azure subscription as a single Azure
> Application.
>
> Papyrus is a customer-hosted runtime for durable, event-driven agent work. This plan
> provisions a hardened Ubuntu 24.04 appliance running the Papyrus runtime, with a dedicated
> data disk for durable state and systemd supervision. It contacts no vendor control plane,
> and no data leaves your environment. The software is licensed BYOL, so no purchase is
> required from Marketplace for this plan.
>
> What you choose: VM size, Azure region, whether the onboarding port is reachable from
> outside the virtual network, and the allowed source address range.
>
> After deployment: complete the first-run onboarding flow to bind Microsoft Entra ID as the
> identity authority, register a model endpoint (Azure OpenAI in your own tenant, any
> OpenAI-compatible endpoint, or a self-hosted model), and activate your deployment-bound
> license.
>
> Prerequisites: an Azure subscription, a Microsoft Entra tenant, and a model endpoint. No
> model endpoint is needed at deploy time.
>
> Included: the runtime, its execution sandbox, and the onboarding flow. Not included: model
> hosting, GPU capacity, or a Transact purchase. The appliance runs on infrastructure in your
> subscription, and Azure usage is billed to you directly.

Three deliberate choices in that description, so they do not get edited away later:

- **"It contacts no vendor control plane"** rather than a bare "secure" or "private" —
  specific, true, and the sentence a security reviewer will test.
- **The "Not included" line.** Naming what the plan does *not* include prevents a buyer
  expecting hosted models. Descriptions that list only inclusions generate support tickets.
- **Prerequisites say no model endpoint is needed at deploy time**, so someone deploying into
  an empty subscription knows they can start before choosing a model.

### Search keywords
> durable agent runtime, customer-hosted AI agent, Entra ID agent governance

### Categories
Primary: **AI + machine learning**. Secondary: **Developer tools**.
(Confirm the current category list in Partner Center; "IT & management tools" is the
fallback for the second slot.)

### Industries
**Government** and **Financial services** are plausible. Confirm which industry values are
actually offered for commercial listings, and whether Defence is among them — do not
assume.

---

## 3. Claims discipline

The listing is a public, contractual statement. Two things needed checking before copy went
final; one is now resolved and one still stands.

1. **The sandbox mechanism — resolved, and the README is wrong.** `README.md` claims agent
   code runs under **Bubblewrap**. It does not. There is no bubblewrap or bwrap reference
   anywhere in the source, and the only sandbox package is `@landstrip/landstrip`. The
   actual mechanism is `landstrip`: Landlock for filesystem confinement plus seccomp,
   selected in `runtime.ts` as `processSandbox: 'landstrip'` with isolation `landlock` on
   Linux (and `seatbelt` on macOS for development). Copy above now says Landlock + seccomp,
   which we also validated on real amd64. **Fix the README** — it is a public claim about a
   sandbox that isn't the one shipping. Related: the class is still named
   `NonoWorkspaceSandbox`, a leftover from the `nono-ts` era, which misleads anyone reading
   the code for a security review.
2. **Do not imply certification.** `government-il4`, `government-il6`, and `dod` are
   *deployment profiles* — configuration modes, not authorisations. Nothing in the listing
   should read as a FedRAMP or DoD authorisation claim. If a certification exists, state it
   precisely and only with evidence.

Worth leading with because it is already earned: Papyrus was **deemed Awardable on the DoW
CDAO Tradewinds Solutions Marketplace**. That is a real credential — confirm you are
cleared to cite the badge in a commercial listing.

Also deliberately absent: any cost-savings figure. We have no token or cost telemetry, so
no savings claim can be substantiated yet.

---

## 4. Inputs only you can supply

1. Partner Center enrollment status — is the account created, and is the Marketplace
   program enrolled? This gates everything else and has lead time.
2. Publisher / legal entity name as it should appear.
3. Support URL, email, phone; engineering contact.
4. Privacy policy URL. Terms of use decision: your own agreement or the Standard Contract.
5. Logo exports at 48×48, 216×216, 255×115.
6. Screenshots — I can capture these from the onboarding flow if you want them.
7. Confirmation on the Tradewinds Awardable citation.
8. Whether any certification claim should appear, and the evidence for it.

---

## 5. Notes for Certification

This field is read by Microsoft's certification team, not customers. Write it as **test
instructions**. Never put credentials in it — those go in the separate Credentials table.
Cert notes are reused on every future publish of this offer, so keep them here rather than
retyping them at each submission.

Paste-ready:

```
Papyrus - self-deployed appliance (BYOL). Azure Application, solution template plan.

WHAT THIS DEPLOYS
A single Ubuntu 24.04 virtual machine running the Papyrus runtime as one container, plus a
dedicated data disk for appliance state, and a systemd unit that supervises the container.
No other Azure services are required. Expected deployment time is 5-10 minutes, most of
which is the container image pull.

PREREQUISITES FOR VALIDATION
1. A subscription able to create a VM, managed disk, VNet, NSG and public IP.
2. The VM requires outbound internet on first boot. cloud-init installs Docker from the
   Ubuntu package repositories and then pulls the container image from the registry below.
   Without outbound access the template still deploys, but the container will not start.
3. No registry credentials are required. The container image is publicly pullable, so
   nothing is needed from the Credentials section.
4. Any valid SSH public key may be used for the VM admin. It is only needed for the optional
   shell checks below; the appliance itself is verified over HTTP.

PARAMETERS
Template defaults are intended to work as-is. Two worth knowing:
- vmSize defaults to Standard_D2as_v7. If unavailable in your region, any 2 vCPU / 8 GB
  amd64 general-purpose size works.
- allowedSourceAddressPrefix defaults to *, so the onboarding port is reachable.
The container runs as non-root (uid 65532) and needs no elevated capabilities.

HOW TO VERIFY
1. Deployment reaches Succeeded. The resource group contains a VM named <namePrefix>-appliance
   and a data disk named <namePrefix>-appliance-data.
2. HTTP check (no shell needed). Allow 3-6 minutes after the VM reports running, then:
     curl -s http://<publicIpAddress>:3210/api/config/public
   Expected: JSON containing "bootstrap": true and a deploymentId.
3. UI check. Open http://<publicIpAddress>:3210/ in a browser.
   Expected: the Papyrus first-run onboarding page, HTTP 200.
4. Optional shell checks, over SSH as the admin user:
     sudo docker ps
     Expected: one container named "papyrus", status "Up ... (healthy)".
     sudo docker exec papyrus node /healthcheck.mjs
     Expected: exit code 0. This probe asserts the execution sandbox permits filesystem
     access inside the workspace and denies it outside.

EXPECTED STATE WITHOUT A LICENCE OR MODEL ENDPOINT
The appliance intentionally boots into a first-run onboarding flow rather than the full
product. A signed licence and a model endpoint are entered during onboarding and are not
required to validate this deployment. Validation should treat "onboarding served and the
container healthy" as success.

The appliance contacts no Beag Labs control plane at any point, so there is no callback or
external service to validate against.

SUPPORT FOR CERTIFICATION QUESTIONS
<name>, <email>
```

### Credentials table

**Leave it empty.** The container image is publicly pullable, so certification needs no
credential from us, and the deployment form asks the customer for none.

An earlier version of this plan required a pull-only registry credential here. That was
removed, because it was never viable: a solution template's ARM JSON is visible to every
customer and its deployment history is readable by anyone with access to the resource
group, so a credential could not be embedded safely, and a customer had no business
holding one for our registry.

### Four things to check before submitting

1. **The template cannot deploy with pure defaults.** `authenticationType` defaults to
   `sshPublicKey` but `sshPublicKey` defaults to an empty string, so a click-through
   deployment fails on VM creation. `createUiDefinition.json` must prompt for it with
   validation — which is a reason that file still needs writing.
2. **`Standard_D2as_v7` is not in every region.** It was chosen because `Standard_B2s` was
   capacity-restricted in eastus. If the cert team deploys somewhere it is unavailable, the
   deployment fails with `SkuNotAvailable`. Either pick a more universally available default
   or be sure the note lands.
3. **The outbound-internet dependency is easy to miss** and produces a *successful deployment
   with a dead appliance* — the worst failure mode for a certification run. It is called out
   above for that reason.
4. **Cert deploys with parameter defaults**, so make sure `main.example.parameters.json` is
   not what gets used: it narrows `allowedSourceAddressPrefix` to a single IP and would lock
   the cert team out of port 3210.
