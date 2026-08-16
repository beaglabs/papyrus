import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { McpServer, Principal, Role, Runtime, Session, Workspace } from '@papyrus/contracts'

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
        email TEXT, auth_method TEXT NOT NULL, created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind = 'goose'),
        mode TEXT NOT NULL, model_json TEXT NOT NULL, command TEXT, endpoint TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assignments (
        principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (principal_type, principal_id, resource_type, resource_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), runtime_id TEXT NOT NULL REFERENCES runtimes(id),
        title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        kind TEXT NOT NULL, occurred_at TEXT NOT NULL, data_json TEXT NOT NULL
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

  createRuntime(input: Omit<Runtime, 'id' | 'kind' | 'createdAt'>): Runtime {
    const runtime: Runtime = { id: crypto.randomUUID(), kind: 'goose', createdAt: new Date().toISOString(), ...input }
    this.sqlite.prepare('INSERT INTO runtimes VALUES(?,?,?,?,?,?,?,?)').run(
      runtime.id, runtime.name, runtime.kind, runtime.mode, JSON.stringify(runtime.model), runtime.command ?? null, runtime.endpoint ?? null, runtime.createdAt,
    )
    return runtime
  }

  getRuntime(id: string): Runtime | undefined {
    const row = this.sqlite.prepare('SELECT * FROM runtimes WHERE id=?').get(id) as Row | undefined
    return row ? this.runtime(row) : undefined
  }

  listRuntimes(): Runtime[] { return (this.sqlite.prepare('SELECT * FROM runtimes ORDER BY name').all() as Row[]).map((row) => this.runtime(row)) }

  private runtime(row: Row): Runtime {
    return { id: String(row.id), name: String(row.name), kind: 'goose', mode: row.mode as Runtime['mode'], model: JSON.parse(String(row.model_json)),
      ...(row.command ? { command: String(row.command) } : {}), ...(row.endpoint ? { endpoint: String(row.endpoint) } : {}), createdAt: String(row.created_at) }
  }

  assign(principalType: 'user' | 'group', principalId: string, resourceType: 'workspace' | 'runtime', resourceId: string): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO assignments VALUES(?,?,?,?,?)').run(principalType, principalId, resourceType, resourceId, new Date().toISOString())
  }

  isAssigned(userId: string, resourceType: 'workspace' | 'runtime', resourceId: string): boolean {
    const row = this.sqlite.prepare(`SELECT 1 FROM assignments a WHERE a.resource_type=? AND a.resource_id=? AND
      ((a.principal_type='user' AND a.principal_id=?) OR (a.principal_type='group' AND EXISTS
      (SELECT 1 FROM group_members gm WHERE gm.group_id=a.principal_id AND gm.user_id=?))) LIMIT 1`).get(resourceType, resourceId, userId, userId)
    return Boolean(row)
  }

  assignedUserIds(resourceType: 'workspace' | 'runtime', resourceId: string): string[] {
    const direct = this.sqlite.prepare("SELECT principal_id id FROM assignments WHERE resource_type=? AND resource_id=? AND principal_type='user'").all(resourceType, resourceId) as Row[]
    const groups = this.sqlite.prepare(`SELECT gm.user_id id FROM assignments a JOIN group_members gm ON gm.group_id=a.principal_id
      WHERE a.resource_type=? AND a.resource_id=? AND a.principal_type='group'`).all(resourceType, resourceId) as Row[]
    return [...new Set([...direct, ...groups].map((row) => String(row.id)))]
  }

  createSession(ownerId: string, workspaceId: string, runtimeId: string, title: string): Session {
    const now = new Date().toISOString()
    const session: Session = { id: crypto.randomUUID(), ownerId, workspaceId, runtimeId, title, status: 'ready', createdAt: now, updatedAt: now }
    this.sqlite.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(session.id, ownerId, workspaceId, runtimeId, title, session.status, now, now)
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sqlite.prepare(`SELECT id,owner_id ownerId,workspace_id workspaceId,runtime_id runtimeId,title,status,
      created_at createdAt,updated_at updatedAt FROM sessions WHERE id=?`).get(id) as unknown as Session | undefined
  }

  listSessions(): Session[] {
    return this.sqlite.prepare(`SELECT id,owner_id ownerId,workspace_id workspaceId,runtime_id runtimeId,title,status,
      created_at createdAt,updated_at updatedAt FROM sessions ORDER BY updated_at DESC`).all() as unknown as Session[]
  }

  setSessionStatus(id: string, status: Session['status']): void {
    this.sqlite.prepare('UPDATE sessions SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
  }

  addRuntimeEvent(sessionId: string, kind: string, occurredAt: string, data: unknown): void {
    this.sqlite.prepare('INSERT INTO runtime_events(session_id,kind,occurred_at,data_json) VALUES(?,?,?,?)').run(sessionId, kind, occurredAt, JSON.stringify(data))
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

  grantTool(workspaceId: string, mcpServerId: string, toolName: string): void {
    this.sqlite.prepare('INSERT OR IGNORE INTO tool_grants VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), workspaceId, mcpServerId, toolName, 'allow', new Date().toISOString())
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
