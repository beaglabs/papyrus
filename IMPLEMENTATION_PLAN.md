# Implementation Plan: Real Auth Adapters + Iroh Stream Reuse

## Overview
Two major improvements to make Papyrus production-ready:
1. **Real Auth Adapters** — Replace 4 mock adapters with cryptographic verification
2. **Iroh Stream Reuse** — Eliminate connection-per-message overhead

---

## Phase 1: Iroh Stream Reuse (Infrastructure — Do First)

### Files to Modify
- `packages/network/src/iroh.ts` — Core networking changes

### Changes
1. **Add connection pool** to `PapyrusNetwork` class:
   ```typescript
   private connections = new Map<string, Connection>()
   private connectionCleanupInterval?: NodeJS.Timeout
   ```

2. **Modify `sendToPeer()`** to reuse connections:
   - Check `this.connections.get(peerId)`
   - If exists and `closeReason() === null`, reuse
   - Else reconnect and store new connection
   - Always open fresh `BiStream` per message (streams are single-use)

3. **Modify `handleConnection()`** to store incoming connections:
   - After `conn = await accepting.connect()`, call `this.connections.set(peerId, conn)`
   - Add listener for `conn.closed()` to auto-remove from pool

4. **Add `cleanupStaleConnections()` method**:
   - Iterate connections, remove if `closeReason() !== null`
   - Run every 30s via `setInterval`

5. **Modify `disconnect(peerId)`** to explicitly close connection:
   - Get connection from pool, call `conn.close(0n, [])`
   - Remove from pool

6. **Modify `close()`** to close all connections:
   - Iterate all connections, call `close()`
   - Clear cleanup interval
   - Then close endpoint

### Complexity: Medium
### Risk: Low (internal change, same external API)
### Tests: Add integration test for connection reuse

---

## Phase 2: WebAuthn Adapter (Highest Impact — Most Practical)

### Dependencies to Add
```bash
# Core
pnpm add -w @simplewebauthn/server@^10.0.0

# Web
pnpm add -F @papyrus/web @simplewebauthn/browser@^10.0.0
```

### SQLite Tables (`packages/daemon/src/database.ts`)
```sql
CREATE TABLE webauthn_credentials (
  id INTEGER PRIMARY KEY,
  member_key TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webauthn_member ON webauthn_credentials(member_key);
```

### Core Changes (`packages/core/src/auth/adapter.ts`)
- Replace `WebAuthnAdapter` with real implementation using `@simplewebauthn/server`
- `start()`: Return `generateRegistrationOptions()` or `generateAuthenticationOptions()` based on flow
- `complete()`: Call `verifyRegistrationResponse()` or `verifyAuthenticationResponse()`
- Store/verify credentials via new DB methods

### Daemon Endpoints (`packages/daemon/src/server.ts`)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/webauthn/register/start` | POST | Generate registration challenge |
| `/api/auth/webauthn/register/finish` | POST | Verify registration, store credential |
| `/api/auth/webauthn/authenticate/start` | POST | Generate authentication challenge |
| `/api/auth/webauthn/authenticate/finish` | POST | Verify assertion, create session token |

### Web Frontend (`packages/web/src/components/`)
- Add WebAuthn registration/authentication UI in Login/Auth flow
- Use `@simplewebauthn/browser` for `startRegistration()` / `startAuthentication()`
- Fall back to auto-login if WebAuthn not available

### Complexity: High
### Risk: Medium (new deps, new flows)
### Tests: Unit tests for adapter, integration for endpoints

---

## Phase 3: OIDC Adapter (Enterprise SSO)

### Dependencies
None — implement manually with `fetch` + `node:crypto`

### SQLite Tables (`packages/daemon/src/database.ts`)
```sql
CREATE TABLE oidc_sessions (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
```

### Core Changes (`packages/core/src/auth/adapter.ts`)
- Replace `OIDCAdapter` with real implementation
- `start()`: Generate PKCE `code_verifier` + `code_challenge`, build authorization URL with `state`, `nonce`, `code_challenge`
- `complete()`: Exchange code for tokens at `token_endpoint`, fetch JWKS from `jwks_uri`, verify ID token JWT (RS256/ES256)
- Extract claims: `sub` → `externalId`, `name`/`email` → `displayName`

### Daemon Endpoints (`packages/daemon/src/server.ts`)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/oidc/authorize` | GET | Redirect to IdP authorization endpoint |
| `/api/auth/oidc/callback` | GET | Handle IdP callback, exchange code, create session |

### Complexity: Medium
### Risk: Low (no new deps, standard OAuth2)
### Tests: Unit tests for JWT verification

---

## Phase 4: CAC/PIV Adapter (DoD — SIPRNet Required)

### Dependencies
None — use `node:crypto.X509Certificate`

### SQLite Tables (`packages/daemon/src/database.ts`)
```sql
CREATE TABLE cac_ca_certs (
  id INTEGER PRIMARY KEY,
  cert_pem TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  issuer TEXT NOT NULL,
  not_before TEXT NOT NULL,
  not_after TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Daemon HTTPS Configuration
- Add `https` server alongside HTTP (or replace HTTP in SIPRNet profile)
- `requestCert: true`, `rejectUnauthorized: false` (verify in adapter)
- CA bundle configurable via `PAPYRUS_CAC_CA_BUNDLE` env var

### Core Changes (`packages/core/src/auth/adapter.ts`)
- Replace `CACPIVAdapter` with real implementation
- `start()`: Return mTLS challenge with nonce
- `complete()`: Verify client certificate chain against CA bundle
  - Parse client cert from TLS handshake
  - Verify chain using `crypto.X509Certificate`
  - Check expiration, revocation (CRL/OCSP optional)
  - Extract Subject DN → `externalId`, CN → `displayName`

### Daemon Endpoints (`packages/daemon/src/server.ts`)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/cac/challenge` | GET | Return mTLS challenge |
| `/api/auth/cac/verify` | POST | Verify client cert (called after mTLS handshake) |

### CLI (`packages/cli/src/commands/auth.ts`)
- `papyrus auth configure-cac --ca-bundle <path>` — Load DoD CA bundle

### Complexity: High
### Risk: Medium (requires HTTPS, TLS config)
### Tests: Unit tests for cert verification (requires test certs)

---

## Phase 5: SAML Adapter (DoD — Lower Priority)

### Dependencies
```bash
pnpm add -w saml2-js@^3.0.0
```

### SQLite Tables
```sql
CREATE TABLE saml_sessions (
  relay_state TEXT PRIMARY KEY,
  auth_request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
```

### Core Changes (`packages/core/src/auth/adapter.ts`)
- Replace `SAMLAdapter` with real implementation using `saml2-js`
- `start()`: Generate AuthnRequest, return SSO URL
- `complete()`: Verify SAML response signature, extract attributes

### Daemon Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/saml/authorize` | GET | Redirect to IdP SSO URL |
| `/api/auth/saml/acs` | POST | Assertion Consumer Service — verify response, create session |

### Complexity: High
### Risk: Medium (new dep, XML complexity)
### Tests: Unit tests for response parsing

---

## Implementation Order

| Order | Task | Rationale |
|-------|------|-----------|
| 1 | **Iroh Stream Reuse** | Infrastructure improvement, no breaking changes, benefits all P2P |
| 2 | **WebAuthn Adapter** | Most practical, works in all profiles, no special hardware |
| 3 | **OIDC Adapter** | Enterprise requirement, no deps, standard flow |
| 4 | **CAC/PIV Adapter** | DoD/SIPRNet requirement, requires HTTPS config |
| 5 | **SAML Adapter** | Legacy DoD, lower priority, needs library |

---

## SQLite Migration Strategy

Add new tables in `database.ts` `initDb()`:
```typescript
// After existing tables
db.exec(`
  CREATE TABLE IF NOT EXISTS webauthn_credentials (...);
  CREATE TABLE IF NOT EXISTS oidc_sessions (...);
  CREATE TABLE IF NOT EXISTS cac_ca_certs (...);
  CREATE TABLE IF NOT EXISTS saml_sessions (...);
`)
```
Run on daemon startup — no migration tool needed for new tables.

---

## Testing Strategy

### Unit Tests (Core)
- `packages/core/tests/auth-adapters.test.ts` — Test all 4 adapters with mock data
- JWT verification tests (OIDC)
- X509 verification tests (CAC/PIV)
- CBOR/signature tests (WebAuthn)

### Integration Tests (Daemon)
- Start daemon, hit auth endpoints, verify session tokens
- Test profile-gated adapter selection
- Test token refresh/revocation

### E2E Tests (Web)
- Playwright: WebAuthn registration + login
- Playwright: OIDC flow (mock IdP)
- Playwright: Auto-login flow still works

---

## Rollout Plan

1. **Iroh Stream Reuse** → Test → Merge
2. **WebAuthn Adapter** → Test → Merge
3. **OIDC Adapter** → Test → Merge
4. **CAC/PIV Adapter** → Test → Merge
5. **SAML Adapter** → Test → Merge

Each phase is independently mergeable and deployable.

---

## Estimated Effort

| Phase | Estimate |
|-------|----------|
| Iroh Stream Reuse | 2-4 hours |
| WebAuthn Adapter | 8-12 hours |
| OIDC Adapter | 4-6 hours |
| CAC/PIV Adapter | 6-10 hours |
| SAML Adapter | 6-10 hours |
| **Total** | **26-42 hours** |

---

## Next Steps

1. Approve this plan
2. Start with Phase 1 (Iroh Stream Reuse) — lowest risk, immediate performance gain
3. For each phase: implement → test → typecheck → build → run tests → merge