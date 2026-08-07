/**
 * SQLite-backed project persistence.
 *
 * Stores projects, nodes, and edges in a single SQLite database at
 * ~/.papyrus/papyrus.db. Replaces the previous JSON file storage.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasNodeDoc, EdgeDoc } from '@papyrus/core/nodes/types'
import Database from 'better-sqlite3'
import { DEFAULT_ORGANIZATION_ID, runMigrations } from './migrations.js'

const DB_DIR = join(process.env.HOME ?? '~', '.papyrus')
const DB_PATH = join(DB_DIR, 'papyrus.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true })
  }

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      flow_role TEXT NOT NULL DEFAULT 'artifact',
      position_x REAL NOT NULL DEFAULT 0,
      position_y REAL NOT NULL DEFAULT 0,
      fields TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'smoothstep',
      created_by TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      created_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id INTEGER PRIMARY KEY,
      member_key TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      aaguid TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_invites_project ON invites(project_id);
    CREATE INDEX IF NOT EXISTS idx_webauthn_member ON webauthn_credentials(member_key);
    CREATE INDEX IF NOT EXISTS idx_webauthn_credential ON webauthn_credentials(credential_id);
  `)

  runMigrations(db)

  return db
}

export interface ProjectData {
  id: string
  organizationId: string
  name: string
  createdAt: string
  revision: number
  nodes: CanvasNodeDoc[]
  edges: EdgeDoc[]
}

/** List all known projects. */
export function listProjects(organizationId?: string): ProjectData[] {
  const db = getDb()
  const rows = (
    organizationId
      ? db
          .prepare(
            'SELECT id, organization_id, name, created_at, revision FROM projects WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
          )
          .all(organizationId)
      : db
          .prepare(
            'SELECT id, organization_id, name, created_at, revision FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC',
          )
          .all()
  ) as Array<{
    id: string
    organization_id: string
    name: string
    created_at: string
    revision: number
  }>

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    createdAt: row.created_at,
    revision: row.revision,
    nodes: getNodes(db, row.id),
    edges: getEdges(db, row.id),
  }))
}

/** Create a new project. */
export function createProject(
  name: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
  createdBy = 'system',
): ProjectData {
  const db = getDb()
  const id = `proj-${randomUUID()}`
  const now = new Date().toISOString()

  db.prepare(
    'INSERT INTO projects (id, organization_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, organizationId, name, createdBy, now, now)

  return { id, organizationId, name, createdAt: now, revision: 0, nodes: [], edges: [] }
}

/** Load a project from the database. */
export function loadProject(id: string): ProjectData | null {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT id, organization_id, name, created_at, revision FROM projects WHERE id = ? AND deleted_at IS NULL',
    )
    .get(id) as
    | {
        id: string
        organization_id: string
        name: string
        created_at: string
        revision: number
      }
    | undefined

  if (!row) return null

  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    createdAt: row.created_at,
    revision: row.revision,
    nodes: getNodes(db, row.id),
    edges: getEdges(db, row.id),
  }
}

/** Save canvas state (nodes + edges) to the database. */
export function saveCanvas(id: string, nodes: CanvasNodeDoc[], edges: EdgeDoc[]): void {
  const db = getDb()
  const project = db
    .prepare('SELECT organization_id, revision FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(id) as { organization_id: string; revision: number } | undefined
  if (!project) throw new Error(`Project not found: ${id}`)

  const transaction = db.transaction(() => {
    // Delete existing nodes and edges
    db.prepare('DELETE FROM edges WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM nodes WHERE project_id = ?').run(id)

    // Insert new nodes
    const insertNode = db.prepare(
      'INSERT INTO nodes (id, project_id, organization_id, type, category, flow_role, position_x, position_y, fields, status, created_by, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const node of nodes) {
      insertNode.run(
        node.id,
        id,
        project.organization_id,
        node.type,
        node.category,
        node.flowRole ?? 'artifact',
        node.position.x,
        node.position.y,
        JSON.stringify(node.fields ?? {}),
        node.status ?? 'draft',
        node.createdBy ?? null,
        node.updatedAt,
        project.revision,
      )
    }

    // Insert new edges
    const insertEdge = db.prepare(
      'INSERT INTO edges (id, project_id, organization_id, from_node, to_node, kind, created_by, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const edge of edges) {
      insertEdge.run(
        edge.id,
        id,
        project.organization_id,
        edge.from,
        edge.to,
        edge.kind ?? 'smoothstep',
        edge.createdBy ?? null,
        edge.updatedAt,
        project.revision,
      )
    }

    // Update project timestamp
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id)
  })

  transaction()
}

export interface CanvasOperationInput {
  id: string
  projectId: string
  actorKey: string
  entityType: 'node' | 'edge' | 'document' | 'project'
  entityId: string
  operationType: 'create' | 'update' | 'delete'
  payload?: unknown
  baseRevision?: number
}

export interface CanvasOperationResult {
  operationId: string
  projectRevision: number
  duplicate: boolean
}

/**
 * Atomically persist the authoritative canvas materialization and its immutable operation.
 * Duplicate operation IDs are acknowledged without being applied twice.
 */
export function commitCanvasOperation(
  input: CanvasOperationInput,
  nodes: CanvasNodeDoc[],
  edges: EdgeDoc[],
): CanvasOperationResult {
  const database = getDb()
  return database.transaction(() => {
    const duplicate = database
      .prepare('SELECT project_revision FROM operations WHERE id = ?')
      .get(input.id) as { project_revision: number } | undefined
    if (duplicate) {
      return {
        operationId: input.id,
        projectRevision: duplicate.project_revision,
        duplicate: true,
      }
    }

    const project = database
      .prepare('SELECT organization_id, revision FROM projects WHERE id = ? AND deleted_at IS NULL')
      .get(input.projectId) as { organization_id: string; revision: number } | undefined
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    if (input.baseRevision !== undefined && input.baseRevision > project.revision) {
      throw new Error(
        `Invalid future revision ${input.baseRevision}; current is ${project.revision}`,
      )
    }

    const revision = project.revision + 1
    database
      .prepare("UPDATE projects SET revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(revision, input.projectId)

    saveCanvas(input.projectId, nodes, edges)
    database
      .prepare(
        `INSERT INTO operations
          (id, organization_id, project_id, project_revision, actor_key, entity_type,
           entity_id, operation_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        project.organization_id,
        input.projectId,
        revision,
        input.actorKey,
        input.entityType,
        input.entityId,
        input.operationType,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        new Date().toISOString(),
      )

    return { operationId: input.id, projectRevision: revision, duplicate: false }
  })()
}

export function getProjectRevision(projectId: string): number {
  const row = getDb()
    .prepare('SELECT revision FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(projectId) as { revision: number } | undefined
  if (!row) throw new Error(`Project not found: ${projectId}`)
  return row.revision
}

export interface StoredOperation {
  id: string
  projectId: string
  projectRevision: number
  actorKey: string
  entityType: string
  entityId: string
  operationType: string
  payload: unknown
  createdAt: string
}

export function getStoredOperations(projectId: string, sinceRevision = 0): StoredOperation[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM operations WHERE project_id = ? AND project_revision > ? ORDER BY project_revision ASC',
    )
    .all(projectId, sinceRevision) as Array<{
    id: string
    project_id: string
    project_revision: number
    actor_key: string
    entity_type: string
    entity_id: string
    operation_type: string
    payload: string | null
    created_at: string
  }>
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectRevision: row.project_revision,
    actorKey: row.actor_key,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operationType: row.operation_type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    createdAt: row.created_at,
  }))
}

export function loadDocumentState(projectId: string, nodeId: string): Uint8Array | null {
  const row = getDb()
    .prepare('SELECT yjs_state FROM documents WHERE project_id = ? AND node_id = ?')
    .get(projectId, nodeId) as { yjs_state: Buffer } | undefined
  return row ? new Uint8Array(row.yjs_state) : null
}

export function saveDocumentState(
  projectId: string,
  nodeId: string,
  state: Uint8Array,
  revision: number,
): void {
  const database = getDb()
  const project = database
    .prepare('SELECT organization_id FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(projectId) as { organization_id: string } | undefined
  if (!project) throw new Error(`Project not found: ${projectId}`)
  database
    .prepare(
      `INSERT INTO documents
        (organization_id, project_id, node_id, yjs_state, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, node_id) DO UPDATE SET
         yjs_state = excluded.yjs_state,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
    )
    .run(
      project.organization_id,
      projectId,
      nodeId,
      Buffer.from(state),
      revision,
      new Date().toISOString(),
    )
}

/** Delete a project and all its data. */
export function deleteProject(id: string): boolean {
  const db = getDb()
  const result = db
    .prepare(
      "UPDATE projects SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL",
    )
    .run(id)
  return result.changes > 0
}

// ── Internal helpers ──────────────────────────────────────────

function getNodes(db: Database.Database, projectId: string): CanvasNodeDoc[] {
  const rows = db.prepare('SELECT * FROM nodes WHERE project_id = ?').all(projectId) as Array<{
    id: string
    project_id: string
    type: string
    category: string
    flow_role: string
    position_x: number
    position_y: number
    fields: string
    status: string
    created_by: string | null
    updated_at: number
  }>

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    category: row.category as CanvasNodeDoc['category'],
    flowRole: row.flow_role as CanvasNodeDoc['flowRole'],
    position: { x: row.position_x, y: row.position_y },
    fields: JSON.parse(row.fields),
    status: row.status as CanvasNodeDoc['status'],
    createdBy: row.created_by ?? 'system',
    updatedAt: row.updated_at,
  }))
}

function getEdges(db: Database.Database, projectId: string): EdgeDoc[] {
  const rows = db.prepare('SELECT * FROM edges WHERE project_id = ?').all(projectId) as Array<{
    id: string
    project_id: string
    from_node: string
    to_node: string
    kind: string
    created_by: string | null
    updated_at: number
  }>

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    from: row.from_node,
    to: row.to_node,
    kind: row.kind,
    createdBy: row.created_by ?? '',
    updatedAt: row.updated_at,
  }))
}

/** Close the database connection. */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// ── Invite helpers ──────────────────────────────────────────

export interface InviteRecord {
  code: string
  projectId: string
  role: string
  createdBy: string
  expiresAt: string
  createdAt: string
}

/** Create a new invite. */
export function createInvite(
  code: string,
  projectId: string,
  role: string,
  createdBy: string,
  expiresAt: string,
): InviteRecord {
  const db = getDb()
  db.prepare(
    'INSERT INTO invites (code, project_id, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(code, projectId, role, createdBy, expiresAt)

  return { code, projectId, role, createdBy, expiresAt, createdAt: new Date().toISOString() }
}

/** Look up an invite by code. */
export function getInvite(code: string): InviteRecord | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as
    | {
        code: string
        project_id: string
        role: string
        created_by: string
        expires_at: string
        created_at: string
      }
    | undefined

  if (!row) return null

  return {
    code: row.code,
    projectId: row.project_id,
    role: row.role,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

/** Delete an invite (after use or expiration). */
export function deleteInvite(code: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM invites WHERE code = ?').run(code)
  return result.changes > 0
}

/** Clean up expired invites. */
export function cleanupExpiredInvites(): number {
  const db = getDb()
  const result = db.prepare("DELETE FROM invites WHERE expires_at < datetime('now')").run()
  return result.changes
}

// ── WebAuthn Credentials ─────────────────────────────────────────

export interface WebAuthnCredential {
  id: number
  memberKey: string
  credentialId: string
  publicKey: string
  counter: number
  aaguid: string | null
  createdAt: string
}

export function saveWebAuthnCredential(
  memberKey: string,
  credentialId: string,
  publicKey: string,
  counter: number,
  aaguid: string | null,
): WebAuthnCredential {
  const db = getDb()
  db.prepare(
    'INSERT INTO webauthn_credentials (member_key, credential_id, public_key, counter, aaguid) VALUES (?, ?, ?, ?, ?)',
  ).run(memberKey, credentialId, publicKey, counter, aaguid)

  const row = db
    .prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?')
    .get(credentialId) as
    | {
        id: number
        member_key: string
        credential_id: string
        public_key: string
        counter: number
        aaguid: string | null
        created_at: string
      }
    | undefined

  if (!row) throw new Error('Failed to save WebAuthn credential')

  return {
    id: row.id,
    memberKey: row.member_key,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    aaguid: row.aaguid,
    createdAt: row.created_at,
  }
}

export function getWebAuthnCredential(credentialId: string): WebAuthnCredential | null {
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?')
    .get(credentialId) as
    | {
        id: number
        member_key: string
        credential_id: string
        public_key: string
        counter: number
        aaguid: string | null
        created_at: string
      }
    | undefined

  if (!row) return null

  return {
    id: row.id,
    memberKey: row.member_key,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    aaguid: row.aaguid,
    createdAt: row.created_at,
  }
}

export function getWebAuthnCredentialsForMember(memberKey: string): WebAuthnCredential[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM webauthn_credentials WHERE member_key = ? ORDER BY created_at DESC')
    .all(memberKey) as Array<{
    id: number
    member_key: string
    credential_id: string
    public_key: string
    counter: number
    aaguid: string | null
    created_at: string
  }>

  return rows.map((row) => ({
    id: row.id,
    memberKey: row.member_key,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    aaguid: row.aaguid,
    createdAt: row.created_at,
  }))
}

export function updateWebAuthnCredentialCounter(credentialId: string, counter: number): boolean {
  const db = getDb()
  const result = db
    .prepare('UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?')
    .run(counter, credentialId)
  return result.changes > 0
}

export function deleteWebAuthnCredential(credentialId: string): boolean {
  const db = getDb()
  const result = db
    .prepare('DELETE FROM webauthn_credentials WHERE credential_id = ?')
    .run(credentialId)
  return result.changes > 0
}
