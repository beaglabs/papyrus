import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Approval, Attachment, Elicitation, Environment, Invitation, InvitationIdentityKind, McpServer, Principal, Role, Session, SessionEvent, SessionRun, ToolGrant } from '@papyrus/contracts'

type Row = Record<string, unknown>

export class PapyrusDatabase {
  readonly sqlite: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sqlite = new DatabaseSync(path)
    this.sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    this.migrate()
  }

  close(): void { this.sqlite.close() }

  private migrate(): void {
    // The original schema used workspace table/column names. They remain as
    // physical storage identifiers so existing on-prem databases migrate
    // without copying session history; every contract and policy surface uses
    // Environment.
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        email TEXT, picture_url TEXT, auth_method TEXT NOT NULL, token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
        PRIMARY KEY (user_id, role)
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, identity_kind TEXT NOT NULL, identity_value TEXT NOT NULL,
        display_name TEXT NOT NULL, email TEXT, role TEXT NOT NULL, auth_method TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','cancelled','expired')),
        invited_by TEXT NOT NULL REFERENCES users(id), accepted_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, cancelled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL REFERENCES groups(id), user_id TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY (group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assignments (
        principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (principal_type, principal_id, resource_type, resource_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent TEXT NOT NULL,
        title TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '/', status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        actor_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
        stop_reason TEXT, error TEXT, started_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT REFERENCES session_runs(id), kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT NOT NULL REFERENCES session_runs(id), requester_id TEXT NOT NULL REFERENCES users(id),
        tool_title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','cancelled')),
        requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(id), reason TEXT
      );
      CREATE TABLE IF NOT EXISTS elicitations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES session_runs(id),
        status TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT,
        requested_at TEXT NOT NULL, responded_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL CHECK(transport = 'http'),
        endpoint TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL,
        oauth_status TEXT NOT NULL DEFAULT 'not_required', oauth_issuer TEXT, oauth_error TEXT,
        oauth_access_token TEXT, oauth_refresh_token TEXT, oauth_expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
        state TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES mcp_servers(id), actor_id TEXT NOT NULL REFERENCES users(id),
        issuer TEXT NOT NULL, token_endpoint TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT,
        verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_grants (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id), tool_name TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect = 'allow'), created_at TEXT NOT NULL,
        UNIQUE(workspace_id, mcp_server_id, tool_name)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL,
        actor_id TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        decision TEXT NOT NULL, policy_version TEXT NOT NULL, metadata_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
      CREATE TABLE IF NOT EXISTS licenses (id INTEGER PRIMARY KEY CHECK(id = 1), document_json TEXT NOT NULL, activated_at TEXT NOT NULL);
    `)
    // Migration for databases created before token_version existed.
    const userColumns = this.sqlite.prepare('PRAGMA table_info(users)').all() as Row[]
    if (!userColumns.some((column) => column.name === 'token_version')) {
      this.sqlite.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0')
    }
    if (!userColumns.some((column) => column.name === 'picture_url')) {
      this.sqlite.exec('ALTER TABLE users ADD COLUMN picture_url TEXT')
    }
    const invitationColumns = this.sqlite.prepare('PRAGMA table_info(invitations)').all() as Row[]
    if (!invitationColumns.some((column) => column.name === 'identity_kind')) {
      this.sqlite.exec(`
        DROP INDEX IF EXISTS invitations_one_pending_identity;
        CREATE TABLE invitations_v2 (
          id TEXT PRIMARY KEY, identity_kind TEXT NOT NULL, identity_value TEXT NOT NULL,
          display_name TEXT NOT NULL, email TEXT, role TEXT NOT NULL, auth_method TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','accepted','cancelled','expired')),
          invited_by TEXT NOT NULL REFERENCES users(id), accepted_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, cancelled_at TEXT
        );
        INSERT INTO invitations_v2
          (id,identity_kind,identity_value,display_name,email,role,auth_method,status,invited_by,accepted_by,created_at,expires_at,accepted_at,cancelled_at)
          SELECT id,'email',lower(email),email,email,role,auth_method,status,invited_by,accepted_by,created_at,expires_at,accepted_at,cancelled_at FROM invitations;
        DROP TABLE invitations;
        ALTER TABLE invitations_v2 RENAME TO invitations;
      `)
    }
    const sessionColumns = this.sqlite.prepare('PRAGMA table_info(sessions)').all() as Row[]
    if (!sessionColumns.some((column) => column.name === 'cwd')) {
      this.sqlite.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT NOT NULL DEFAULT '/'")
    }
    const eventColumns = this.sqlite.prepare('PRAGMA table_info(runtime_events)').all() as Row[]
    if (!eventColumns.some((column) => column.name === 'run_id')) {
      this.sqlite.exec('ALTER TABLE runtime_events ADD COLUMN run_id TEXT REFERENCES session_runs(id)')
    }
    const mcpColumns = this.sqlite.prepare('PRAGMA table_info(mcp_servers)').all() as Row[]
    for (const [name, definition] of Object.entries({ oauth_status: "TEXT NOT NULL DEFAULT 'not_required'", oauth_issuer: 'TEXT', oauth_error: 'TEXT', oauth_access_token: 'TEXT', oauth_refresh_token: 'TEXT', oauth_expires_at: 'TEXT' })) {
      if (!mcpColumns.some((column) => column.name === name)) this.sqlite.exec(`ALTER TABLE mcp_servers ADD COLUMN ${name} ${definition}`)
    }
    this.sqlite.prepare("UPDATE assignments SET resource_type='environment' WHERE resource_type='workspace'").run()
    this.sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending_identity
        ON invitations(identity_kind, lower(identity_value), auth_method) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS invitations_status_created ON invitations(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS session_runs_session_started ON session_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS runtime_events_session_sequence ON runtime_events(session_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS session_runs_one_active ON session_runs(session_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS approvals_session_requested ON approvals(session_id, requested_at DESC);
      CREATE INDEX IF NOT EXISTS attachments_session_created ON attachments(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS elicitations_session_requested ON elicitations(session_id, requested_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_per_run_tool ON approvals(run_id, tool_title) WHERE status='pending';
    `)
  }

  transaction<T>(operation: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.sqlite.exec('COMMIT')
      return result
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  getSetting(key: string): string | undefined {
    return (this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined
  }

  setSetting(key: string, value: string): void {
    this.sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  countUsers(): number { return Number((this.sqlite.prepare('SELECT count(*) count FROM users').get() as Row).count) }

  upsertUser(input: Omit<Principal, 'id' | 'roles'>): Principal {
    const existing = this.sqlite.prepare('SELECT id FROM users WHERE external_id = ?').get(input.externalId) as Row | undefined
    const id = existing ? String(existing.id) : crypto.randomUUID()
    this.sqlite.prepare(`INSERT INTO users(id,external_id,display_name,email,picture_url,auth_method,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(external_id) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,picture_url=excluded.picture_url,auth_method=excluded.auth_method`)
      .run(id, input.externalId, input.displayName, input.email ?? null, input.pictureUrl ?? null, input.authMethod, new Date().toISOString())
    return this.getPrincipal(id) as Principal
  }

  getPrincipal(id: string): Principal | undefined {
    const row = this.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined
    if (!row) return undefined
    const roles = (this.sqlite.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(id) as Row[]).map((item) => item.role as Role)
    return {
      id: String(row.id), externalId: String(row.external_id), displayName: String(row.display_name),
      ...(row.email ? { email: String(row.email) } : {}),
      ...(row.picture_url ? { pictureUrl: String(row.picture_url) } : {}), roles,
      authMethod: row.auth_method as Principal['authMethod'],
    }
  }

  listPrincipals(): Principal[] {
    return (this.sqlite.prepare('SELECT id FROM users ORDER BY display_name').all() as Row[])
      .map((row) => this.getPrincipal(String(row.id)))
      .filter((principal): principal is Principal => Boolean(principal))
  }

  setRole(userId: string, role: Role): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO user_roles(user_id,role) VALUES(?,?)').run(userId, role)
  }

  createInvitation(input: {
    identityKind: InvitationIdentityKind
    identityValue: string
    displayName: string
    email?: string
    role: Role
    authMethod: Invitation['authMethod']
    invitedBy: string
    expiresAt: string
  }): Invitation {
    this.sqlite.prepare("UPDATE invitations SET status='expired' WHERE status='pending' AND expires_at<=?").run(new Date().toISOString())
    const invitation: Invitation = {
      id: crypto.randomUUID(), identityKind: input.identityKind, identityValue: input.identityValue,
      displayName: input.displayName, ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
      role: input.role, authMethod: input.authMethod, status: 'pending', invitedBy: input.invitedBy,
      createdAt: new Date().toISOString(), expiresAt: input.expiresAt,
    }
    this.sqlite.prepare('INSERT INTO invitations(id,identity_kind,identity_value,display_name,email,role,auth_method,status,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(invitation.id, invitation.identityKind, invitation.identityValue, invitation.displayName, invitation.email ?? null, invitation.role, invitation.authMethod, invitation.status, invitation.invitedBy, invitation.createdAt, invitation.expiresAt)
    return invitation
  }

  listInvitations(): Invitation[] {
    return (this.sqlite.prepare('SELECT * FROM invitations ORDER BY created_at DESC').all() as Row[]).map((row) => this.invitation(row))
  }

  getInvitation(id: string): Invitation | undefined {
    const row = this.sqlite.prepare('SELECT * FROM invitations WHERE id=?').get(id) as Row | undefined
    return row ? this.invitation(row) : undefined
  }

  cancelInvitation(id: string): Invitation | undefined {
    const now = new Date().toISOString()
    const result = this.sqlite.prepare("UPDATE invitations SET status='cancelled',cancelled_at=? WHERE id=? AND status='pending' AND expires_at>?").run(now, id, now)
    return Number(result.changes) === 1 ? this.getInvitation(id) : undefined
  }

  migrateExternalIdentity(legacyExternalId: string, input: Omit<Principal, 'id' | 'roles'>): Principal | undefined {
    const legacy = this.sqlite.prepare('SELECT id FROM users WHERE external_id=?').get(legacyExternalId) as Row | undefined
    if (!legacy) return undefined
    const collision = this.sqlite.prepare('SELECT id FROM users WHERE external_id=?').get(input.externalId) as Row | undefined
    if (collision && String(collision.id) !== String(legacy.id)) throw new Error('Stable identity is already assigned to another user')
    this.sqlite.prepare('UPDATE users SET external_id=?,display_name=?,email=?,picture_url=?,auth_method=? WHERE id=?')
      .run(input.externalId, input.displayName, input.email ?? null, input.pictureUrl ?? null, input.authMethod, String(legacy.id))
    return this.getPrincipal(String(legacy.id))
  }

  resolveAuthenticatedUser(
    input: Omit<Principal, 'id' | 'roles'>,
    selectors: Array<{ kind: InvitationIdentityKind; value: string }>,
  ): { principal: Principal; invitation?: Invitation; created: boolean } {
    const existing = this.sqlite.prepare('SELECT id FROM users WHERE external_id=?').get(input.externalId) as Row | undefined
    if (existing) return { principal: this.upsertUser(input), created: false }
    if (this.getSetting('bootstrapComplete') !== 'true') return { principal: this.upsertUser(input), created: true }
    const now = new Date().toISOString()
    let pending: Row | undefined
    for (const selector of selectors) {
      pending = this.sqlite.prepare("SELECT * FROM invitations WHERE identity_kind=? AND lower(identity_value)=lower(?) AND auth_method=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 1")
        .get(selector.kind, selector.value, input.authMethod, now) as Row | undefined
      if (pending) break
    }
    if (!pending) throw new Error('INVITATION_REQUIRED')
    return this.transaction(() => {
      const id = crypto.randomUUID()
      const displayName = input.displayName || String(pending.display_name)
      const email = input.email ?? (pending.email ? String(pending.email) : undefined)
      this.sqlite.prepare('INSERT INTO users(id,external_id,display_name,email,picture_url,auth_method,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, input.externalId, displayName, email ?? null, input.pictureUrl ?? null, input.authMethod, now)
      this.sqlite.prepare('INSERT INTO user_roles(user_id,role) VALUES(?,?)').run(id, String(pending.role))
      this.sqlite.prepare("UPDATE invitations SET status='accepted',accepted_by=?,accepted_at=? WHERE id=? AND status='pending'")
        .run(id, now, String(pending.id))
      return { principal: this.getPrincipal(id) as Principal, invitation: this.getInvitation(String(pending.id)) as Invitation, created: true }
    })
  }

  private invitation(row: Row): Invitation {
    const status = String(row.status) === 'pending' && Date.parse(String(row.expires_at)) <= Date.now() ? 'expired' : String(row.status)
    return {
      id: String(row.id), identityKind: row.identity_kind as InvitationIdentityKind,
      identityValue: String(row.identity_value), displayName: String(row.display_name),
      ...(row.email ? { email: String(row.email) } : {}), role: row.role as Role,
      authMethod: row.auth_method as Invitation['authMethod'], status: status as Invitation['status'],
      invitedBy: String(row.invited_by), ...(row.accepted_by ? { acceptedBy: String(row.accepted_by) } : {}),
      createdAt: String(row.created_at), expiresAt: String(row.expires_at),
      ...(row.accepted_at ? { acceptedAt: String(row.accepted_at) } : {}),
      ...(row.cancelled_at ? { cancelledAt: String(row.cancelled_at) } : {}),
    }
  }

  getTokenVersion(userId: string): number {
    const row = this.sqlite.prepare('SELECT token_version token_version FROM users WHERE id=?').get(userId) as Row | undefined
    return Number(row?.token_version ?? 0)
  }

  incrementTokenVersion(userId: string): void {
    this.sqlite.prepare('UPDATE users SET token_version = token_version + 1 WHERE id=?').run(userId)
  }

  createEnvironment(input: Pick<Environment, 'name' | 'description'>): Environment {
    const environment: Environment = { id: crypto.randomUUID(), ...input, createdAt: new Date().toISOString() }
    this.sqlite.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(environment.id, environment.name, environment.description, environment.createdAt)
    return environment
  }

  getEnvironment(id: string): Environment | undefined {
    return this.sqlite.prepare('SELECT id,name,description,created_at createdAt FROM workspaces WHERE id=?').get(id) as unknown as Environment | undefined
  }

  listEnvironments(): Environment[] {
    return this.sqlite.prepare('SELECT id,name,description,created_at createdAt FROM workspaces ORDER BY name').all() as unknown as Environment[]
  }

  assign(principalType: 'user' | 'group', principalId: string, resourceType: 'environment', resourceId: string): void {
    if (principalType === 'user' && !this.getPrincipal(principalId)) throw new Error('User not found')
    if (!this.getEnvironment(resourceId)) throw new Error('Environment not found')
    this.sqlite.prepare('INSERT OR IGNORE INTO assignments VALUES(?,?,?,?,?)').run(principalType, principalId, resourceType, resourceId, new Date().toISOString())
  }

  isAssigned(userId: string, resourceType: 'environment', resourceId: string): boolean {
    const row = this.sqlite.prepare(`SELECT 1 FROM assignments a WHERE a.resource_type=? AND a.resource_id=? AND
      ((a.principal_type='user' AND a.principal_id=?) OR (a.principal_type='group' AND EXISTS
      (SELECT 1 FROM group_members gm WHERE gm.group_id=a.principal_id AND gm.user_id=?))) LIMIT 1`).get(resourceType, resourceId, userId, userId)
    return Boolean(row)
  }

  assignedUserIds(resourceType: 'environment', resourceId: string): string[] {
    const direct = this.sqlite.prepare("SELECT principal_id id FROM assignments WHERE resource_type=? AND resource_id=? AND principal_type='user'").all(resourceType, resourceId) as Row[]
    const groups = this.sqlite.prepare(`SELECT gm.user_id id FROM assignments a JOIN group_members gm ON gm.group_id=a.principal_id
      WHERE a.resource_type=? AND a.resource_id=? AND a.principal_type='group'`).all(resourceType, resourceId) as Row[]
    return [...new Set([...direct, ...groups].map((row) => String(row.id)))]
  }

  createSession(ownerId: string, environmentId: string, agent: string, title: string, cwd = '/'): Session {
    const now = new Date().toISOString()
    const session: Session = { id: crypto.randomUUID(), ownerId, environmentId, agent, title, cwd, status: 'ready', createdAt: now, updatedAt: now }
    this.sqlite.prepare(`INSERT INTO sessions(id,owner_id,workspace_id,agent,title,cwd,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(session.id, ownerId, environmentId, agent, title, cwd, session.status, now, now)
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sqlite.prepare(`SELECT id,owner_id ownerId,workspace_id environmentId,agent,title,cwd,status,
      created_at createdAt,updated_at updatedAt FROM sessions WHERE id=?`).get(id) as unknown as Session | undefined
  }

  listSessions(): Session[] {
    return this.sqlite.prepare(`SELECT id,owner_id ownerId,workspace_id environmentId,agent,title,cwd,status,
      created_at createdAt,updated_at updatedAt FROM sessions ORDER BY updated_at DESC`).all() as unknown as Session[]
  }

  setSessionStatus(id: string, status: Session['status']): void {
    this.sqlite.prepare('UPDATE sessions SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
  }

  deleteSession(id: string): boolean {
    return this.transaction(() => {
      this.sqlite.prepare('DELETE FROM approvals WHERE session_id=?').run(id)
      this.sqlite.prepare('DELETE FROM attachments WHERE session_id=?').run(id)
      this.sqlite.prepare('DELETE FROM elicitations WHERE session_id=?').run(id)
      this.sqlite.prepare('DELETE FROM runtime_events WHERE session_id=?').run(id)
      this.sqlite.prepare('DELETE FROM session_runs WHERE session_id=?').run(id)
      return Number(this.sqlite.prepare('DELETE FROM sessions WHERE id=?').run(id).changes) > 0
    })
  }

  createElicitation(sessionId: string, runId: string, request: Record<string, unknown>): Elicitation {
    const item: Elicitation = { id: crypto.randomUUID(), sessionId, runId, status: 'pending', request, requestedAt: new Date().toISOString() }
    this.sqlite.prepare('INSERT INTO elicitations(id,session_id,run_id,status,request_json,requested_at) VALUES(?,?,?,?,?,?)').run(item.id, sessionId, runId, item.status, JSON.stringify(request), item.requestedAt)
    return item
  }

  listElicitations(sessionId: string): Elicitation[] {
    const rows = this.sqlite.prepare('SELECT id,session_id sessionId,run_id runId,status,request_json requestJson,response_json responseJson,requested_at requestedAt,responded_at respondedAt FROM elicitations WHERE session_id=? ORDER BY requested_at DESC').all(sessionId) as Row[]
    return rows.map((row) => ({ id: String(row.id), sessionId: String(row.sessionId), runId: String(row.runId), status: row.status as Elicitation['status'], request: JSON.parse(String(row.requestJson)), ...(row.responseJson ? { response: JSON.parse(String(row.responseJson)) } : {}), requestedAt: String(row.requestedAt), ...(row.respondedAt ? { respondedAt: String(row.respondedAt) } : {}) }))
  }

  respondElicitation(id: string, response: Record<string, unknown>): Elicitation | undefined {
    const status = response.action === 'accept' ? 'accepted' : response.action === 'cancel' ? 'cancelled' : 'declined'
    const respondedAt = new Date().toISOString()
    const result = this.sqlite.prepare("UPDATE elicitations SET status=?,response_json=?,responded_at=? WHERE id=? AND status='pending'").run(status, JSON.stringify(response), respondedAt, id)
    if (!result.changes) return undefined
    return this.listElicitations(String((this.sqlite.prepare('SELECT session_id sessionId FROM elicitations WHERE id=?').get(id) as Row).sessionId)).find((item) => item.id === id)
  }

  beginSessionRun(sessionId: string, actorId: string): SessionRun {
    return this.transaction(() => {
      const session = this.getSession(sessionId)
      if (!session) throw new Error('SESSION_NOT_FOUND')
      if (session.status === 'running') throw new Error('SESSION_BUSY')
      if (session.status === 'stopped') throw new Error('SESSION_STOPPED')
      const run: SessionRun = {
        id: crypto.randomUUID(),
        sessionId,
        actorId,
        status: 'running',
        startedAt: new Date().toISOString(),
      }
      this.sqlite.prepare(`INSERT INTO session_runs(id,session_id,actor_id,status,started_at)
        VALUES(?,?,?,?,?)`).run(run.id, run.sessionId, run.actorId, run.status, run.startedAt)
      this.sqlite.prepare("UPDATE sessions SET status='running',updated_at=? WHERE id=?").run(run.startedAt, sessionId)
      return run
    })
  }

  finishSessionRun(runId: string, status: Exclude<SessionRun['status'], 'running'>, stopReason?: string, error?: string): void {
    this.transaction(() => {
      const run = this.getSessionRun(runId)
      if (!run || run.status !== 'running') return
      const completedAt = new Date().toISOString()
      this.sqlite.prepare(`UPDATE session_runs SET status=?,stop_reason=?,error=?,completed_at=?
        WHERE id=? AND status='running'`).run(status, stopReason ?? null, error ?? null, completedAt, runId)
      const sessionStatus: Session['status'] = status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'ready'
      this.sqlite.prepare(`UPDATE sessions SET status=?,updated_at=?
        WHERE id=? AND status!='stopped'`).run(sessionStatus, completedAt, run.sessionId)
    })
  }

  getSessionRun(id: string): SessionRun | undefined {
    const row = this.sqlite.prepare(`SELECT id,session_id sessionId,actor_id actorId,status,
      stop_reason stopReason,error,started_at startedAt,completed_at completedAt
      FROM session_runs WHERE id=?`).get(id) as Row | undefined
    return row ? this.sessionRun(row) : undefined
  }

  listSessionRuns(sessionId: string): SessionRun[] {
    const rows = this.sqlite.prepare(`SELECT id,session_id sessionId,actor_id actorId,status,
      stop_reason stopReason,error,started_at startedAt,completed_at completedAt
      FROM session_runs WHERE session_id=? ORDER BY started_at DESC`).all(sessionId) as Row[]
    return rows.map((row) => this.sessionRun(row))
  }

  recoverInterruptedSessionRuns(): string[] {
    return this.transaction(() => {
      const rows = this.sqlite.prepare("SELECT id sessionId FROM sessions WHERE status='running'").all() as Row[]
      const sessionIds = rows.map((row) => String(row.sessionId))
      const completedAt = new Date().toISOString()
      this.sqlite.prepare(`UPDATE session_runs SET status='interrupted',stop_reason='daemon_restart',
        error='Daemon restarted before the run completed',completed_at=? WHERE status='running'`).run(completedAt)
      this.sqlite.prepare("UPDATE sessions SET status='interrupted',updated_at=? WHERE status='running'").run(completedAt)
      return sessionIds
    })
  }

  resumeSession(id: string): Session | undefined {
    const now = new Date().toISOString()
    this.sqlite.prepare(`UPDATE sessions SET status='ready',updated_at=?
      WHERE id=? AND status IN ('stopped','failed','interrupted')`).run(now, id)
    return this.getSession(id)
  }

  addRuntimeEvent(sessionId: string, runId: string | undefined, kind: string, occurredAt: string, data: unknown): number {
    const result = this.sqlite.prepare(`INSERT INTO runtime_events(session_id,run_id,kind,occurred_at,data_json)
      VALUES(?,?,?,?,?)`).run(sessionId, runId ?? null, kind, occurredAt, JSON.stringify(data))
    return Number(result.lastInsertRowid)
  }

  listSessionEvents(sessionId: string, after = 0, limit = 200): SessionEvent[] {
    const rows = this.sqlite.prepare(`SELECT id sequence,session_id sessionId,run_id runId,kind,
      occurred_at occurredAt,data_json dataJson FROM runtime_events
      WHERE session_id=? AND id>? ORDER BY id LIMIT ?`).all(sessionId, after, limit) as Row[]
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      sessionId: String(row.sessionId),
      ...(row.runId ? { runId: String(row.runId) } : {}),
      kind: String(row.kind),
      occurredAt: String(row.occurredAt),
      data: JSON.parse(String(row.dataJson)) as unknown,
    }))
  }

  createAttachment(sessionId: string, name: string, mediaType: string, content: Buffer, sha256: string): Attachment {
    const attachment: Attachment = {
      id: crypto.randomUUID(), sessionId, name, mediaType, size: content.length, sha256,
      createdAt: new Date().toISOString(), downloadUrl: '',
    }
    this.sqlite.prepare(`INSERT INTO attachments(id,session_id,name,media_type,size,sha256,content,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(attachment.id, sessionId, name, mediaType, attachment.size, sha256, content, attachment.createdAt)
    return attachment
  }

  listAttachments(sessionId: string): Attachment[] {
    return this.sqlite.prepare(`SELECT id,session_id sessionId,name,media_type mediaType,size,sha256,created_at createdAt,'' downloadUrl
      FROM attachments WHERE session_id=? ORDER BY created_at DESC`).all(sessionId) as unknown as Attachment[]
  }

  getAttachment(id: string): (Attachment & { content: Buffer }) | undefined {
    const row = this.sqlite.prepare(`SELECT id,session_id sessionId,name,media_type mediaType,size,sha256,created_at createdAt,content
      FROM attachments WHERE id=?`).get(id) as Row | undefined
    return row ? {
      id: String(row.id), sessionId: String(row.sessionId), name: String(row.name), mediaType: String(row.mediaType),
      size: Number(row.size), sha256: String(row.sha256), createdAt: String(row.createdAt), downloadUrl: '',
      content: Buffer.from(row.content as Uint8Array),
    } : undefined
  }

  createApproval(sessionId: string, runId: string, requesterId: string, toolTitle: string): Approval {
    const approval: Approval = { id: crypto.randomUUID(), sessionId, runId, requesterId, toolTitle, status: 'pending', requestedAt: new Date().toISOString() }
    this.sqlite.prepare(`INSERT INTO approvals(id,session_id,run_id,requester_id,tool_title,status,requested_at)
      VALUES(?,?,?,?,?,'pending',?)`).run(approval.id, sessionId, runId, requesterId, toolTitle, approval.requestedAt)
    return approval
  }

  getApproval(id: string): Approval | undefined {
    const row = this.sqlite.prepare(`SELECT id,session_id sessionId,run_id runId,requester_id requesterId,
      tool_title toolTitle,status,requested_at requestedAt,decided_at decidedAt,decided_by decidedBy,reason
      FROM approvals WHERE id=?`).get(id) as Row | undefined
    return row ? this.approval(row) : undefined
  }

  listApprovals(sessionId: string): Approval[] {
    return (this.sqlite.prepare(`SELECT id,session_id sessionId,run_id runId,requester_id requesterId,
      tool_title toolTitle,status,requested_at requestedAt,decided_at decidedAt,decided_by decidedBy,reason
      FROM approvals WHERE session_id=? ORDER BY requested_at DESC`).all(sessionId) as Row[]).map((row) => this.approval(row))
  }

  decideApproval(id: string, status: Exclude<Approval['status'], 'pending'>, decidedBy: string | undefined, reason?: string): Approval | undefined {
    const decidedAt = new Date().toISOString()
    const result = this.sqlite.prepare(`UPDATE approvals SET status=?,decided_at=?,decided_by=?,reason=?
      WHERE id=? AND status='pending'`).run(status, decidedAt, decidedBy ?? null, reason ?? null, id)
    return Number(result.changes) === 1 ? this.getApproval(id) : undefined
  }

  cancelPendingApprovals(reason: string): Approval[] {
    const pending = (this.sqlite.prepare("SELECT id FROM approvals WHERE status='pending'").all() as Row[]).map((row) => String(row.id))
    return pending.flatMap((id) => {
      const approval = this.decideApproval(id, 'cancelled', undefined, reason)
      return approval ? [approval] : []
    })
  }

  private sessionRun(row: Row): SessionRun {
    return {
      id: String(row.id),
      sessionId: String(row.sessionId),
      actorId: String(row.actorId),
      status: row.status as SessionRun['status'],
      ...(row.stopReason ? { stopReason: String(row.stopReason) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      startedAt: String(row.startedAt),
      ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}),
    }
  }

  private approval(row: Row): Approval {
    return {
      id: String(row.id), sessionId: String(row.sessionId), runId: String(row.runId), requesterId: String(row.requesterId),
      toolTitle: String(row.toolTitle), status: row.status as Approval['status'], requestedAt: String(row.requestedAt),
      ...(row.decidedAt ? { decidedAt: String(row.decidedAt) } : {}),
      ...(row.decidedBy ? { decidedBy: String(row.decidedBy) } : {}),
      ...(row.reason ? { reason: String(row.reason) } : {}),
    }
  }

  addMcpServer(input: Pick<McpServer, 'name' | 'endpoint'> & Pick<McpServer, 'oauthStatus' | 'oauthIssuer' | 'oauthError'>): McpServer {
    const server: McpServer = { id: crypto.randomUUID(), name: input.name, endpoint: input.endpoint, transport: 'http', enabled: input.oauthStatus === 'not_required', oauthStatus: input.oauthStatus, ...(input.oauthIssuer ? { oauthIssuer: input.oauthIssuer } : {}), ...(input.oauthError ? { oauthError: input.oauthError } : {}), createdAt: new Date().toISOString() }
    this.sqlite.prepare('INSERT INTO mcp_servers(id,name,transport,endpoint,enabled,created_at,oauth_status,oauth_issuer,oauth_error) VALUES(?,?,?,?,?,?,?,?,?)').run(server.id, server.name, server.transport, server.endpoint, server.enabled ? 1 : 0, server.createdAt, server.oauthStatus, server.oauthIssuer ?? null, server.oauthError ?? null)
    return server
  }

  getMcpServer(id: string): McpServer | undefined {
    const row = this.sqlite.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id) as Row | undefined
    return row ? this.mcpServer(row) : undefined
  }

  listMcpServers(): McpServer[] {
    const rows = this.sqlite.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Row[]
    return rows.map((row) => this.mcpServer(row))
  }

  setMcpServerEnabled(id: string, enabled: boolean): McpServer | undefined {
    this.sqlite.prepare('UPDATE mcp_servers SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id)
    return this.getMcpServer(id)
  }

  grantMcpServer(environmentId: string, mcpServerId: string): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO tool_grants VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), environmentId, mcpServerId, '*', 'allow', new Date().toISOString())
  }

  listToolGrants(): ToolGrant[] {
    return this.sqlite.prepare(`SELECT min(id) id,workspace_id environmentId,mcp_server_id mcpServerId,'allow' effect,min(created_at) createdAt
      FROM tool_grants GROUP BY workspace_id,mcp_server_id ORDER BY createdAt DESC`).all() as unknown as ToolGrant[]
  }

  revokeToolGrant(id: string): boolean {
    const grant = this.sqlite.prepare('SELECT workspace_id,mcp_server_id FROM tool_grants WHERE id=?').get(id) as Row | undefined
      ?? this.sqlite.prepare('SELECT workspace_id,mcp_server_id FROM tool_grants WHERE id=(SELECT min(id) FROM tool_grants GROUP BY workspace_id,mcp_server_id HAVING min(id)=?)').get(id) as Row | undefined
    if (!grant) return false
    return Number(this.sqlite.prepare('DELETE FROM tool_grants WHERE workspace_id=? AND mcp_server_id=?').run(String(grant.workspace_id), String(grant.mcp_server_id)).changes) > 0
  }

  isToolGranted(environmentId: string, mcpServerId: string, toolName: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 FROM tool_grants WHERE workspace_id=? AND mcp_server_id=? AND tool_name IN ('*',?)").get(environmentId, mcpServerId, toolName))
  }

  listGrantedMcpServers(environmentId: string): McpServer[] {
    const rows = this.sqlite.prepare(`SELECT DISTINCT s.* FROM mcp_servers s JOIN tool_grants g ON g.mcp_server_id=s.id
      WHERE g.workspace_id=? AND s.enabled=1`).all(environmentId) as Row[]
    return rows.map((row) => this.mcpServer(row))
  }

  createMcpOauthPending(input: { state: string; serverId: string; actorId: string; issuer: string; tokenEndpoint: string; clientId: string; clientSecret?: string; verifier: string; redirectUri: string; resource: string }): void {
    this.sqlite.prepare('INSERT INTO mcp_oauth_pending VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.state, input.serverId, input.actorId, input.issuer, input.tokenEndpoint, input.clientId, input.clientSecret ?? null, input.verifier, input.redirectUri, input.resource, new Date().toISOString())
  }

  getMcpOauthPending(state: string): Row | undefined { return this.sqlite.prepare('SELECT * FROM mcp_oauth_pending WHERE state=?').get(state) as Row | undefined }
  finishMcpOauth(state: string, accessToken: string, refreshToken: string | undefined, expiresAt: string | undefined): McpServer | undefined {
    const pending = this.getMcpOauthPending(state); if (!pending) return undefined
    this.transaction(() => {
      this.sqlite.prepare("UPDATE mcp_servers SET enabled=1,oauth_status='connected',oauth_error=NULL,oauth_access_token=?,oauth_refresh_token=?,oauth_expires_at=? WHERE id=?").run(accessToken, refreshToken ?? null, expiresAt ?? null, String(pending.server_id))
      this.sqlite.prepare('DELETE FROM mcp_oauth_pending WHERE state=?').run(state)
    })
    return this.getMcpServer(String(pending.server_id))
  }

  mcpAccessToken(serverId: string): string | undefined {
    const row = this.sqlite.prepare("SELECT oauth_access_token token FROM mcp_servers WHERE id=? AND oauth_status='connected'").get(serverId) as Row | undefined
    return row?.token ? String(row.token) : undefined
  }

  private mcpServer(row: Row): McpServer {
    return { id: String(row.id), name: String(row.name), transport: 'http', endpoint: String(row.endpoint), enabled: Boolean(row.enabled), oauthStatus: String(row.oauth_status ?? 'not_required') as McpServer['oauthStatus'], ...(row.oauth_issuer ? { oauthIssuer: String(row.oauth_issuer) } : {}), ...(row.oauth_error ? { oauthError: String(row.oauth_error) } : {}), createdAt: String(row.created_at) }
  }
}
