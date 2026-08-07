import type Database from 'better-sqlite3'

export const DEFAULT_ORGANIZATION_ID = 'org-default'

interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function addColumn(db: Database.Database, table: string, definition: string): void {
  const column = definition.trim().split(/\s+/)[0]
  if (column && !hasColumn(db, table, column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'centralized tenancy and operation log',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT 'local.papyrus',
          profile TEXT NOT NULL DEFAULT 'commercial',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS org_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          email TEXT NOT NULL DEFAULT '',
          display_name TEXT,
          avatar_url TEXT,
          role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
          joined_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(org_id, member_key),
          FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
        );

        INSERT OR IGNORE INTO organizations (id, name, domain, profile, created_by)
        VALUES ('${DEFAULT_ORGANIZATION_ID}', 'Papyrus', 'local.papyrus', 'commercial', 'system');
      `)

      addColumn(
        db,
        'projects',
        `organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}'`,
      )
      addColumn(db, 'projects', 'revision INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'projects', 'created_by TEXT')
      addColumn(db, 'projects', 'deleted_at TEXT')
      addColumn(db, 'nodes', `organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}'`)
      addColumn(db, 'nodes', 'revision INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'nodes', 'deleted_at TEXT')
      addColumn(db, 'edges', `organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}'`)
      addColumn(db, 'edges', 'revision INTEGER NOT NULL DEFAULT 0')
      addColumn(db, 'edges', 'deleted_at TEXT')

      db.exec(`
        UPDATE projects SET organization_id = '${DEFAULT_ORGANIZATION_ID}' WHERE organization_id IS NULL;
        UPDATE nodes
        SET organization_id = COALESCE(
          (SELECT organization_id FROM projects WHERE projects.id = nodes.project_id),
          '${DEFAULT_ORGANIZATION_ID}'
        );
        UPDATE edges
        SET organization_id = COALESCE(
          (SELECT organization_id FROM projects WHERE projects.id = edges.project_id),
          '${DEFAULT_ORGANIZATION_ID}'
        );

        CREATE TABLE IF NOT EXISTS project_roles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
          assigned_by TEXT NOT NULL,
          assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, member_key),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          project_revision INTEGER NOT NULL,
          actor_key TEXT NOT NULL,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('node', 'edge', 'document', 'project')),
          entity_id TEXT NOT NULL,
          operation_type TEXT NOT NULL CHECK(operation_type IN ('create', 'update', 'delete')),
          payload TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(project_id, project_revision),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS documents (
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          yjs_state BLOB NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id, node_id),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_nodes_tenant ON nodes(organization_id, project_id);
        CREATE INDEX IF NOT EXISTS idx_edges_tenant ON edges(organization_id, project_id);
        CREATE INDEX IF NOT EXISTS idx_operations_project_revision
          ON operations(organization_id, project_id, project_revision);
        CREATE INDEX IF NOT EXISTS idx_roles_member ON project_roles(member_key, project_id);
      `)
    },
  },
  {
    version: 2,
    name: 'tenant and graph integrity triggers',
    up(db) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS nodes_tenant_insert
        BEFORE INSERT ON nodes
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = NEW.project_id AND p.organization_id = NEW.organization_id AND p.deleted_at IS NULL
          ) THEN RAISE(ABORT, 'node tenant/project mismatch') END;
        END;

        CREATE TRIGGER IF NOT EXISTS edges_integrity_insert
        BEFORE INSERT ON edges
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = NEW.project_id AND p.organization_id = NEW.organization_id AND p.deleted_at IS NULL
          ) THEN RAISE(ABORT, 'edge tenant/project mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM nodes n
            WHERE n.id = NEW.from_node AND n.project_id = NEW.project_id
              AND n.organization_id = NEW.organization_id AND n.deleted_at IS NULL
          ) THEN RAISE(ABORT, 'edge source missing from project') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM nodes n
            WHERE n.id = NEW.to_node AND n.project_id = NEW.project_id
              AND n.organization_id = NEW.organization_id AND n.deleted_at IS NULL
          ) THEN RAISE(ABORT, 'edge target missing from project') END;
        END;
      `)
    },
  },
]

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  for (const migration of migrations) {
    const apply = db.transaction(() => {
      const alreadyApplied = db
        .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
        .get(migration.version)
      if (alreadyApplied) return
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      )
    })
    apply.immediate()
  }
}
