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
the identity. An Owner or Admin must first create an invitation containing the
organizational email, initial fixed role, and required authentication method.

On successful authentication Papyrus matches the validated email and method to
one unexpired pending invitation, then atomically creates the local principal,
assigns the initial role, and marks the invitation accepted. Unmatched identities
receive `INVITATION_REQUIRED` and are not inserted into the user directory.

Invitations expire after seven days. Creation, cancellation, acceptance,
authentication denial, bootstrap denial, role assignment, session revocation,
and logout are recorded in the hash-chained audit log. Secrets, OIDC tokens,
invitation credentials, and certificate bodies are never audit metadata.

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
or issuer-bound organizational email, in that order. The certificate fingerprint
is retained only as authentication evidence. Certificates without a stable
organizational identifier fall back to fingerprint identity and therefore require
administrative reconciliation after renewal.

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
