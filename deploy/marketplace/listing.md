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
| Support URL, email, phone | **needed from you** |
| Engineering contact (name/email) | **needed from you** |
| Privacy policy URL | **needed from you** |
| Terms of use | choose: your own agreement, or the Standard Contract for Microsoft Marketplace |
| Logo: small 48×48 | **needed** (have `assets/papyrus-logo-transparent-v3.png`) |
| Logo: large 216×216 | **needed** |
| Logo: wide 255×115 | **needed** |
| Screenshots (≥1) | **needed** — can be captured from the onboarding UI |
| Videos | optional |
| Categories (pick 2) | proposed below |
| Industries | proposed below |
| Search keywords (3) | draft below |
| Help / getting-started link | our `deploy/azure/README.md` can back this |

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
> Papyrus — self-deployed appliance (BYOL)

### Plan summary
> Deploys the Papyrus appliance into your own subscription. Licensing is handled directly
> with us.

### Plan description
> Provisions a hardened Ubuntu appliance running the Papyrus runtime, with a dedicated data
> disk for durable state and systemd supervision. You choose the VM size, the region, and
> whether the onboarding port is reachable from outside the virtual network. After
> deployment, complete the first-run onboarding flow to bind Entra, register a model
> endpoint, and activate your license. Bring your own license — no purchase is required
> from Marketplace for this plan.

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
