/**
 * RBAC — Role-Based Access Control for projects.
 *
 * Roles:
 * - owner: full access (create, read, update, delete, share, manage roles)
 * - editor: read + write (create, read, update nodes/edges)
 * - viewer: read only (view canvas, export)
 *
 * Roles are stored per-project in SQLite. The project creator is automatically
 * the owner. Owners can assign roles to other members.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const DB_DIR = join(process.env.HOME ?? '~', '.papyrus')
const DB_PATH = join(DB_DIR, 'papyrus.db')

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true })
  }

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
      assigned_by TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, member_key)
    );

    CREATE INDEX IF NOT EXISTS idx_roles_project ON project_roles(project_id);
    CREATE INDEX IF NOT EXISTS idx_roles_member ON project_roles(member_key);
  `)

  return db
}

export type ProjectRole = 'owner' | 'editor' | 'viewer'

export interface RoleAssignment {
  id: number
  projectId: string
  memberKey: string
  role: ProjectRole
  assignedBy: string
  assignedAt: string
}

/** Permissions per role. */
const PERMISSIONS: Record<ProjectRole, Set<string>> = {
  owner: new Set([
    'project:read',
    'project:update',
    'project:delete',
    'project:share',
    'project:export',
    'node:create',
    'node:read',
    'node:update',
    'node:delete',
    'edge:create',
    'edge:read',
    'edge:delete',
    'skill:run',
    'role:assign',
    'role:remove',
    'audit:read',
  ]),
  editor: new Set([
    'project:read',
    'project:export',
    'node:create',
    'node:read',
    'node:update',
    'node:delete',
    'edge:create',
    'edge:read',
    'edge:delete',
    'skill:run',
  ]),
  viewer: new Set(['project:read', 'project:export', 'node:read', 'edge:read']),
}

/**
 * Assign a role to a member for a project.
 */
export function assignRole(
  projectId: string,
  memberKey: string,
  role: ProjectRole,
  assignedBy: string,
): RoleAssignment {
  const db = getDb()
  db.prepare(
    'INSERT OR REPLACE INTO project_roles (project_id, member_key, role, assigned_by) VALUES (?, ?, ?, ?)',
  ).run(projectId, memberKey, role, assignedBy)

  const row = db
    .prepare('SELECT * FROM project_roles WHERE project_id = ? AND member_key = ?')
    .get(projectId, memberKey) as {
    id: number
    project_id: string
    member_key: string
    role: string
    assigned_by: string
    assigned_at: string
  }

  return {
    id: row.id,
    projectId: row.project_id,
    memberKey: row.member_key,
    role: row.role as ProjectRole,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
  }
}

/**
 * Remove a role assignment.
 */
export function removeRole(projectId: string, memberKey: string): boolean {
  const db = getDb()
  const result = db
    .prepare('DELETE FROM project_roles WHERE project_id = ? AND member_key = ?')
    .run(projectId, memberKey)
  return result.changes > 0
}

/**
 * Get a member's role for a project.
 */
export function getRole(projectId: string, memberKey: string): ProjectRole | null {
  const db = getDb()
  const row = db
    .prepare('SELECT role FROM project_roles WHERE project_id = ? AND member_key = ?')
    .get(projectId, memberKey) as { role: string } | undefined
  return (row?.role as ProjectRole) ?? null
}

/**
 * Get all role assignments for a project.
 */
export function getProjectRoles(projectId: string): RoleAssignment[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM project_roles WHERE project_id = ?')
    .all(projectId) as Array<{
    id: number
    project_id: string
    member_key: string
    role: string
    assigned_by: string
    assigned_at: string
  }>

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    memberKey: row.member_key,
    role: row.role as ProjectRole,
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
  }))
}

/**
 * Get all projects a member has access to.
 */
export function getMemberProjects(memberKey: string): Array<{
  projectId: string
  role: ProjectRole
}> {
  const db = getDb()
  const rows = db
    .prepare('SELECT project_id, role FROM project_roles WHERE member_key = ?')
    .all(memberKey) as Array<{ project_id: string; role: string }>

  return rows.map((row) => ({
    projectId: row.project_id,
    role: row.role as ProjectRole,
  }))
}

/**
 * Check if a member has a specific permission for a project.
 */
export function hasPermission(projectId: string, memberKey: string, permission: string): boolean {
  const role = getRole(projectId, memberKey)
  if (!role) return false
  return PERMISSIONS[role]?.has(permission) ?? false
}

/**
 * Ensure a member has a specific permission. Throws if not.
 */
export function requirePermission(projectId: string, memberKey: string, permission: string): void {
  if (!hasPermission(projectId, memberKey, permission)) {
    const role = getRole(projectId, memberKey)
    throw new Error(
      `Permission denied: ${permission} required, member has role "${role ?? 'none'}" on project ${projectId}`,
    )
  }
}
