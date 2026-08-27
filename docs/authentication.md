# Daemon authentication

Papyrus owns authentication at the daemon boundary. ACP clients and administrative
clients never receive IdP access or refresh tokens.

## Authentication challenge

An unauthenticated API or ACP HTTP request receives `401 Unauthorized` with a
machine-readable body:

```json
{
  "error": "authentication_required",
  "code": "UNAUTHENTICATED",
  "methods": ["oidc"],
  "login_url": "https://papyrus.example/api/auth/oidc/start",
  "native_start_url": "https://papyrus.example/api/auth/oidc/native/start"
}
```

A same-origin web client can navigate to `login_url`. Papyrus performs the OIDC
authorization-code flow with PKCE, validates state and nonce, and stores only a
signed, revocable `HttpOnly` session cookie.

## Invitations and onboarding

After the one-time Owner bootstrap is complete, Papyrus does not provision a new
local principal merely because an identity provider or certificate chain accepts
the identity. An Owner or Admin must first create a profile-appropriate pending
identity.

Commercial deployments use a case-insensitive organizational email selector.
The first validated OIDC login must match that email; Papyrus then binds the user
durably to the validated issuer and subject (`iss + sub`). The tenant-branded
entry screen may show a configured organization logo, while the user avatar uses
the optional OIDC `picture` claim and falls back to initials.

Government deployments never use email as the identity selector. A pending
identity uses EDIPI/DoD ID, UPN, PIV UUID, FASC-N, or an issuer-plus-subject
mapping. Contact email is optional metadata. Papyrus extracts all supported
selectors from the CA-validated certificate, matches one unexpired pending
identity, creates the local principal, assigns its initial role, and records the
acceptance in the hash-chained audit log. Government avatars initially use
initials; Papyrus does not extract the cardholder facial-image biometric.

Invitations expire after seven days. Creation, cancellation, acceptance,
application-visible authentication denial, bootstrap denial, role assignment,
session revocation, identity migration, and logout are audited. Secrets, OIDC
tokens, certificate bodies, and biometric objects are never audit metadata.

### Testing provisioning

Use a test deployment with Owner bootstrap already complete. The bootstrap path
deliberately permits the first identity before invitations exist, so it is not a
test of normal provisioning. Do not reset an existing deployment's database or
bootstrap setting to run this check.

For `government-il4` / `government-il6`:

1. Use a **second, previously unenrolled CAC/PIV identity**. For local development,
   use a separate client certificate signed by a development CA already trusted
   by `PAPYRUS_TLS_CA`, with a different stable identifier from the Owner. An
   arbitrary email or self-signed untrusted certificate will not exercise this
   flow. Do not disable client-certificate verification.
2. Before enrollment, authenticate as that identity. A trusted certificate with
   no matching pending identity should receive `403 INVITATION_REQUIRED` from
   `/api/me`, or the enrollment-required screen in the UI. An untrusted certificate
   fails at TLS instead; that is a different test.
3. As Owner, open **Administration → Identity → Create pending CAC/PIV identity**.
   Enter a display name, the identifier actually carried by the second
   certificate, and initial role **User**, then click **Create identity**. For
   example, a development certificate with CN `TEST.MEMBER.1000000002` matches
   EDIPI `1000000002`. Contact email is optional metadata. Verify the entry appears
   under **Pending identities**, not yet as an enrolled user.
4. Authenticate again with the second certificate, using a separate browser
   profile or an explicit client certificate in curl. Verify `/api/me` returns
   `200`, the enrolled display name, `authMethod: "mtls"`, and `roles: ["User"]`.
5. Refresh the Owner's Identity page. The pending entry should disappear and
   the user should appear under **Identity and roles**. The admin overview API
   (`GET /api/admin/overview`) retains the invitation with status `accepted` and
   `acceptedBy` matching that user's ID. The audit API (`GET /api/audit`) should
   contain `CreateInvitation` and `AcceptInvitation` for that invitation.
6. Authenticate again and confirm the same user ID is returned, without another
   pending invitation. As the new User, confirm `/api/admin/overview` returns
   `403` and the Administration navigation item is absent.

For PEM-based development credentials, this read-only request avoids accidentally
reusing the Owner's browser certificate. Substitute paths to your test files:

```sh
curl --include \
  --cacert /path/to/server-ca.pem \
  --cert /path/to/test-user.pem \
  --key /path/to/test-user-key.pem \
  https://127.0.0.1:3210/api/me
```

`--cacert` trusts the **server's** certificate; it may differ from the client CA
configured in `PAPYRUS_TLS_CA`. Use the deployment hostname that matches the server
certificate. Do not use `-k`, share private keys, or use this PEM example to export
a real CAC/PIV private key. For a hardware card, use the browser/card middleware.

Additional negative checks: a different valid certificate must not consume the
pending identity, and a cancelled or expired invitation must not enroll a new
user. Use a fresh identity for each case: existing enrolled users no longer need
invitations. Revoking Papyrus sessions invalidates issued cookie/bearer tokens;
it does **not** revoke a CAC/PIV certificate or block fresh mTLS authentication.

For **commercial OIDC**, use **Administration → Identity → Invite with
organizational OIDC**, enter the second user's organizational email and role,
then sign in as that user through the configured IdP. The button records a pending
invitation; there is currently no email delivery step, so share the deployment URL
yourself. Matching email is used only for initial enrollment; later logins bind to
the validated issuer and subject.

Run the existing automated checks from the repository root without a second
physical certificate or live IdP:

```sh
pnpm --filter @papyrus/contracts build
pnpm --filter @papyrus/web build
pnpm --filter @papyrus/server exec vitest run tests/invitations.test.ts tests/auth.test.ts tests/auth-http.test.ts tests/admin-http.test.ts
```

These tests use isolated temporary databases and test identities. They verify
identity matching, initial roles, session authentication, and authorization;
they do not replace checking your deployment's TLS trust chain or real IdP login.

## Native client browser handoff

A desktop client that cannot read the system browser's cookies uses a one-time
exchange:

1. `POST /api/auth/oidc/native/start`.
2. Open the returned `login_url` in the system browser.
3. Poll the returned `token_url` with JSON containing `transaction_id` and
   `exchange_token`.
4. Treat `202` as pending. A completed exchange returns a revocable Papyrus
   bearer session once, then deletes the transaction.

The exchange token is returned only in the start response and must be kept out of
URLs, logs, analytics, and browser storage. The bearer session is accepted in
`Authorization: Bearer` and can be invalidated with `POST /api/auth/logout`.

## CAC/PIV

Government profiles support direct CA-validated client mTLS. Papyrus derives a renewal-stable local identity from a validated EDIPI, UPN,
PIV UUID, FASC-N, or issuer-plus-subject selector. The certificate fingerprint is
retained only as authentication evidence and can migrate legacy fingerprint-keyed
accounts to a stable selector.

Certificate subject and CN values are authentication metadata, not authoritative
profile names. After a pending government identity is matched, its administratively
enrolled display name and contact email take precedence. Later CAC/PIV logins and
certificate renewal preserve that stored profile. The certificate CN is used only
as a bootstrap or last-resort display fallback when no enrolled profile exists.

For an external CAC/PIV identity proxy, configure:

- `PAPYRUS_TLS_CERT`, `PAPYRUS_TLS_KEY`, and `PAPYRUS_TLS_CA` for the proxy-to-Papyrus mTLS hop.
- `PAPYRUS_IDENTITY_PROXY_ALLOW_FINGERPRINTS` with the allowed proxy client-certificate fingerprints.
- Optionally, `PAPYRUS_IDENTITY_PROXY_CERT_HEADER` (default:
  `x-papyrus-client-certificate`).

The header value is the base64-encoded DER end-user certificate. Papyrus ignores
it unless the immediate TLS client is authenticated and allowlisted. The identity
proxy must validate the end-user certificate chain and revocation status before
forwarding it. Papyrus does not accept forwarded subject or email headers.

## Development credentials

The web UI exposes an explicit development sign-in form only in local mode on
a loopback listener. It issues the same revocable session cookie as other web
authentication flows; identities and roles are never taken from environment
variables. `PAPYRUS_GATEWAY_DEV_TOKEN` remains a local-mode, loopback-only
daemon-client feature. Gateway tokens must contain at least 32 characters and
are accepted only through `Authorization: Bearer` or `X-Secret-Key`.
`GOOSE_SERVER__SECRET_KEY` and URL query tokens are not authentication inputs.
