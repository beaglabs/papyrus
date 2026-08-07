# Offline licensing

Papyrus uses offline Ed25519-signed deployment licenses. Runtime validation never contacts Beag Labs and is suitable for disconnected and air-gapped environments.

## Trust model

- `beag-labs-license-root-public.pem` is the only trusted license authority key.
- The corresponding private key must remain outside this repository and all Papyrus distributions.
- A license contains its signed payload and signature; it cannot nominate a different trusted key.
- Each installation generates `~/.papyrus/deployment-identity.json` with mode `0600`.
- The license is bound to the SHA-256 fingerprint of that deployment public key.

## Offline activation

On the target deployment:

```bash
papyrus license request > papyrus-activation-request.json
```

Move that non-secret request out through the organization's approved transfer process. Beag Labs issues either a 90-day license (`expiresAt` is an ISO-8601 timestamp) or a perpetual license (`expiresAt` is `null`) for its `deploymentId`. Transfer the signed file back and install it:

```bash
papyrus license activate papyrus-license.json
papyrus license validate
```

The activation request contains a public key and deployment fingerprint, not the deployment private key.

## License payload

```json
{
  "licenseId": "papyrus-example-001",
  "licensee": "Example Agency",
  "profile": "niprnet-il4",
  "deploymentId": "<sha256-fingerprint>",
  "issuedAt": "2026-08-07T20:00:00Z",
  "expiresAt": "2026-11-05T20:00:00Z",
  "signature": "<base64-ed25519-signature>"
}
```

The signature covers the canonical, recursively key-sorted JSON of every field except `signature`. The exported `canonicalLicenseJson` and `signLicense` primitives are intended for a separate, access-controlled Beag Labs issuance system; Papyrus ships no license-minting command or private signing material.

## Fail-closed behavior

Without a valid license, the daemon exposes only health, license status, activation request, and activation endpoints. It does not serve the application, initialize Iroh, accept WebSocket sessions, or process normal APIs. A running 90-day pilot is revalidated every minute and peer networking is stopped when it expires.

Back up the deployment identity through the customer's approved protected backup process. Restoring only the license without its deployment identity will correctly fail validation.
