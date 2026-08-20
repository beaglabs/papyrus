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

Government profiles support direct CA-validated client mTLS. Papyrus maps the
certificate SHA-256 fingerprint to a stable local principal.

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

`PAPYRUS_DEV_IDENTITY` and `PAPYRUS_GATEWAY_DEV_TOKEN` are local-mode,
loopback-only features. Gateway tokens must contain at least 32 characters and
are accepted only through `Authorization: Bearer` or `X-Secret-Key`.
`GOOSE_SERVER__SECRET_KEY` and URL query tokens are not authentication inputs.
