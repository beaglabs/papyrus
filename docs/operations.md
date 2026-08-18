# Operations runbook

Backup, recovery, supervision, and disaster-recovery procedures for a Papyrus deployment. Papyrus stores its durable state in a single SQLite database under `PAPYRUS_DATA_DIR` (default `.papyrus`), plus an `identity/` directory holding the deployment P-256 (ECDSA) key pair.

## Backup

SQLite runs in WAL mode, so a consistent online backup is available without stopping the server.

### Recommended: SQLite online backup

```bash
mkdir -p /var/backups/papyrus
sqlite3 /var/lib/papyrus/papyrus.db "VACUUM INTO '/var/backups/papyrus/papyrus-$(date +%Y%m%d%H%M%S).db'"
```

`VACUUM INTO` produces a consistent snapshot while the server is live. Schedule it (e.g. cron or a systemd timer) and copy the result to independent storage.

### Fallback: checkpoint + copy

If the `sqlite3` CLI is unavailable, force a WAL checkpoint and copy all database files:

```bash
sqlite3 papyrus.db "PRAGMA wal_checkpoint(TRUNCATE);"
cp papyrus.db papyrus.db-wal papyrus.db-shm /var/backups/papyrus/
```

Do not copy only `papyrus.db` while `-wal` and `-shm` exist unless the checkpoint has been run; the WAL may hold the most recent transactions.

### What else to back up

- `identity/deployment-private.pem` — the deployment signing key. Losing it breaks audit-checkpoint verification continuity and license activation. Store it in a secrets manager, never in the same backup as the database.
- `identity/deployment-public.pem` — needed by external verifiers; safe to distribute.
- Server/worker TLS keys and the session secret (`PAPYRUS_SESSION_SECRET`) — keep in the secrets manager alongside the deployment key.

## Audit checkpoints

Export a signed, self-verifying snapshot of the audit chain:

```bash
curl -H "Cookie: papyrus_session=$SESSION" https://papyrus.example.gov/api/audit/checkpoint > checkpoint.json
```

The response contains `deploymentId`, `generatedAt`, `count`, `firstSequence`, `lastSequence`, `integrity`, the full `events` array, and a P-256 (ECDSA) `signature` over the rest of the payload. Export checkpoints on a schedule to independently controlled immutable storage — a database administrator can still replace the SQLite file, and only external copies provide tamper evidence outside the host.

### External verification

The deployment public key is returned by `GET /api/license/request`. Verify a checkpoint offline with `node:crypto`:

```js
import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const checkpoint = JSON.parse(readFileSync('checkpoint.json', 'utf8'))
const { signature, ...payload } = checkpoint
const publicKeyPem = readFileSync('deployment-public.pem', 'utf8')
const canonical = (value) =>
  value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`

const ok = verify(null, Buffer.from(canonical(payload)), publicKeyPem, Buffer.from(signature, 'base64'))
console.log(ok ? 'checkpoint verified' : 'checkpoint signature invalid')
```

## Session revocation

- `POST /api/users/:id/revoke-sessions` invalidates every outstanding session for a user (Owner/Admin).
- Changing a role via `POST /api/users/:id/roles` also revokes the user's sessions automatically.

Use these immediately on a suspected credential compromise, CAC revocation, or personnel departure. Note that mTLS/CAC sessions are authenticated per request from the certificate, so they are governed by certificate revocation at the TLS boundary rather than the cookie revocation list.

## Runtime supervision

- **Prompt timeout** — `PAPYRUS_PROMPT_TIMEOUT_MS` (default 600000) aborts a prompt turn and reclaims the runtime process when exceeded.
- **Health** — `GET /api/health` reports server mode, profile, goose availability, Cedar version, and bootstrap status. `GET /api/runtimes/:id/health` reports a single runtime's health. The worker exposes `GET /health` on its own port.
- **Worker auth** — the worker enforces mutual TLS and, when set, `PAPYRUS_WORKER_ALLOW_FINGERPRINTS` restricts connections to an explicit list of client-certificate SHA-256 fingerprints.

### systemd units

Server:

```ini
[Service]
ExecStart=/usr/bin/node --enable-fips /opt/papyrus/apps/server/dist/index.js
Restart=on-failure
RestartSec=5
User=papyrus
Group=papyrus
EnvironmentFile=/etc/papyrus/server.env
```

Worker:

```ini
[Service]
ExecStart=/usr/bin/node /opt/papyrus/apps/worker/dist/index.js
Restart=on-failure
RestartSec=5
User=papyrus
Group=papyrus
EnvironmentFile=/etc/papyrus/worker.env
```

## Recovery and disaster recovery

### Restore procedure

1. Stop the server (`systemctl stop papyrus`).
2. Restore the database backup over `PAPYRUS_DATA_DIR/papyrus.db` (remove any stale `-wal`/`-shm` files first).
3. Restore `identity/` and the server/worker environment files from the secrets manager.
4. Start the server and verify `GET /api/health` and `GET /api/license/status`.

### Disaster recovery

- **RPO** is bounded by your backup schedule; run checkpoints/backups at the interval your data-loss tolerance allows.
- **RTO** is bounded by how quickly a fresh host can be provisioned, the backup copied back, and TLS/identity material restored. Pre-stage the restore secrets in an offline/air-gapped recovery location.
- Keep at least one offline backup and one audit checkpoint copy outside the primary host; a host compromise invalidates both the database and any co-located copies.
- Rehearse restore quarterly and record the observed RTO; a DR plan that has never been exercised is not a plan.

## FIPS and Node.js

- Run with Node.js 24+ (`--enable-fips` for government profiles). Verify with `node -e "console.log(require('node:crypto').getFips())"` → `1`.
- The deployment key, license signatures, session HMACs, and audit hashes use Node's built-in `node:crypto`, so FIPS posture depends on the underlying OpenSSL module being FIPS-validated in your environment. Confirm the module is on the applicable validated list; this repository does not assert it.
