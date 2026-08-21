import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Approval, McpServer, Principal, Role, Session, SessionEvent, SessionRun, ToolGrant, Workspace } from '@papyrus/contracts'

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
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        email TEXT, auth_method TEXT NOT NULL, token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
        PRIMARY KEY (user_id, role)
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
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT NOT NULL REFERENCES session_runs(id), requester_id TEXT NOT NULL REFERENCES users(id),
        tool_title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','cancelled')),
        requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT REFERENCES users(id), reason TEXT
      );
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL CHECK(transport = 'http'),
        endpoint TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL
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
    const sessionColumns = this.sqlite.prepare('PRAGMA table_info(sessions)').all() as Row[]
    if (!sessionColumns.some((column) => column.name === 'cwd')) {
      this.sqlite.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT NOT NULL DEFAULT '/'")
    }
    const eventColumns = this.sqlite.prepare('PRAGMA table_info(runtime_events)').all() as Row[]
    if (!eventColumns.some((column) => column.name === 'run_id')) {
      this.sqlite.exec('ALTER TABLE runtime_events ADD COLUMN run_id TEXT REFERENCES session_runs(id)')
    }
    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS session_runs_session_started ON session_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS runtime_events_session_sequence ON runtime_events(session_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS session_runs_one_active ON session_runs(session_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS approvals_session_requested ON approvals(session_id, requested_at DESC);
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
    this.sqlite.prepare(`INSERT INTO users(id,external_id,display_name,email,auth_method,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(external_id) DO UPDATE SET display_name=excluded.display_name,email=excluded.email,auth_method=excluded.auth_method`)
      .run(id, input.externalId, input.displayName, input.email ?? null, input.authMethod, new Date().toISOString())
    return this.getPrincipal(id) as Principal
  }

  getPrincipal(id: string): Principal | undefined {
    const row = this.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined
    if (!row) return undefined
    const roles = (this.sqlite.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(id) as Row[]).map((item) => item.role as Role)
    return {
      id: String(row.id), externalId: String(row.external_id), displayName: String(row.display_name),
      ...(row.email ? { email: String(row.email) } : {}), roles,
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

  getTokenVersion(userId: string): number {
    const row = this.sqlite.prepare('SELECT token_version token_version FROM users WHERE id=?').get(userId) as Row | undefined
    return Number(row?.token_version ?? 0)
  }

  incrementTokenVersion(userId: string): void {
    this.sqlite.prepare('UPDATE users SET token_version = token_version + 1 WHERE id=?').run(userId)
  }

  createWorkspace(input: Pick<Workspace, 'name' | 'description'>): Workspace {
    const workspace: Workspace = { id: crypto.randomUUID(), ...input, createdAt: new Date().toISOString() }
    this.sqlite.prepare('INSERT INTO workspaces VALUES(?,?,?,?)').run(workspace.id, workspace.name, workspace.description, workspace.createdAt)
    return workspace
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.sqlite.prepare('SELECT id,name,description,created_at createdAt FROM workspaces WHERE id=?').get(id) as unknown as Workspace | undefined
  }

  listWorkspaces(): Workspace[] {
    return this.sqlite.prepare('SELECT id,name,description,created_at createdAt FROM workspaces ORDER BY name').all() as unknown as Workspace[]
  }

  assign(principalType: 'user' | 'group', principalId: string, resourceType: 'workspace', resourceId: string): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO assignments VALUES(?,?,?,?,?)').run(principalType, principalId, resourceType, resourceId, new Date().toISOString())
  }

  isAssigned(userId: string, resourceType: 'workspace', resourceId: string): boolean {
    const row = this.sqlite.prepare(`SELECT 1 FROM assignments a WHERE a.resource_type=? AND a.resource_id=? AND
      ((a.principal_type='user' AND a.principal_id=?) OR (a.principal_type='group' AND EXISTS
      (SELECT 1 FROM group_members gm WHERE gm.group_id=a.principal_id AND gm.user_id=?))) LIMIT 1`).get(resourceType, resourceId, userId, userId)
    return Boolean(row)
  }

  assignedUserIds(resourceType: 'workspace', resourceId: string): string[] {
    const direct = this.sqlite.prepare("SELECT principal_id id FROM assignments WHERE resource_type=? AND resource_id=? AND principal_type='user'").all(resourceType, resourceId) as Row[]
    const groups = this.sqlite.prepare(`SELECT gm.user_id id FROM assignments a JOIN group_members gm ON gm.group_id=a.principal_id
      WHERE a.resource_type=? AND a.resource_id=? AND a.principal_type='group'`).all(resourceType, resourceId) as Row[]
    return [...new Set([...direct, ...groups].map((row) => String(row.id)))]
  }

  createSession(ownerId: string, workspaceId: string, agent: string, title: string, cwd = '/'): Session {
    const now = new Date().toISOString()
    const session: Session = { id: crypto.randomUUID(), ownerId, workspaceId, agent, title, cwd, status: 'ready', createdAt: now, updatedAt: now }
    this.sqlite.prepare(`INSERT INTO sessions(id,owner_id,workspace_id,agent,title,cwd,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(session.id, ownerId, workspaceId, agent, title, cwd, session.status, now, now)
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sqlite.prepare(`SELECT id,owner_id ownerId,workspace_id workspaceId,agent,title,cwd,status,
      created_at createdAt,updated_at updatedAt FROM sessions WHERE id=?`).get(id) as unknown as Session | undefined
  }

  listSessions(): Session[] {
    return this.sqlite.prepare(`SELECT id,owner_id ownerId,workspace_id workspaceId,agent,title,cwd,status,
      created_at createdAt,updated_at updatedAt FROM sessions ORDER BY updated_at DESC`).all() as unknown as Session[]
  }

  setSessionStatus(id: string, status: Session['status']): void {
    this.sqlite.prepare('UPDATE sessions SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
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

  addMcpServer(input: Pick<McpServer, 'name' | 'endpoint'>): McpServer {
    const server: McpServer = { id: crypto.randomUUID(), name: input.name, endpoint: input.endpoint, transport: 'http', enabled: true, createdAt: new Date().toISOString() }
    this.sqlite.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?,?,?)').run(server.id, server.name, server.transport, server.endpoint, 1, server.createdAt)
    return server
  }

  getMcpServer(id: string): McpServer | undefined {
    const row = this.sqlite.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id) as Row | undefined
    return row ? { id: String(row.id), name: String(row.name), transport: 'http', endpoint: String(row.endpoint), enabled: Boolean(row.enabled), createdAt: String(row.created_at) } : undefined
  }

  listMcpServers(): McpServer[] {
    const rows = this.sqlite.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Row[]
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), transport: 'http', endpoint: String(row.endpoint), enabled: Boolean(row.enabled), createdAt: String(row.created_at) }))
  }

  setMcpServerEnabled(id: string, enabled: boolean): McpServer | undefined {
    this.sqlite.prepare('UPDATE mcp_servers SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id)
    return this.getMcpServer(id)
  }

  grantTool(workspaceId: string, mcpServerId: string, toolName: string): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO tool_grants VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), workspaceId, mcpServerId, toolName, 'allow', new Date().toISOString())
  }

  listToolGrants(): ToolGrant[] {
    return this.sqlite.prepare(`SELECT id,workspace_id workspaceId,mcp_server_id mcpServerId,tool_name toolName,effect,created_at createdAt
      FROM tool_grants ORDER BY created_at DESC`).all() as unknown as ToolGrant[]
  }

  revokeToolGrant(id: string): boolean {
    return Number(this.sqlite.prepare('DELETE FROM tool_grants WHERE id=?').run(id).changes) === 1
  }

  isToolGranted(workspaceId: string, mcpServerId: string, toolName: string): boolean {
    return Boolean(this.sqlite.prepare('SELECT 1 FROM tool_grants WHERE workspace_id=? AND mcp_server_id=? AND tool_name=?').get(workspaceId, mcpServerId, toolName))
  }

  listGrantedMcpServers(workspaceId: string): McpServer[] {
    const rows = this.sqlite.prepare(`SELECT DISTINCT s.* FROM mcp_servers s JOIN tool_grants g ON g.mcp_server_id=s.id
      WHERE g.workspace_id=? AND s.enabled=1`).all(workspaceId) as Row[]
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), transport: 'http', endpoint: String(row.endpoint), enabled: true, createdAt: String(row.created_at) }))
  }
}
