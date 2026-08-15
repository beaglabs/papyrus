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
  {
    version: 3,
    name: 'persistent persona conversations',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          persona TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          nodes TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session
          ON chat_messages(project_id, member_key, persona, created_at);
      `)
    },
  },
  {
    version: 4,
    name: 'persistent MCP project sessions',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          revoked_at TEXT,
          UNIQUE(project_id, member_key),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_sessions_project
          ON mcp_sessions(project_id, member_key);
      `)
    },
  },
  {
    version: 5,
    name: 'durable generation tasks',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS generation_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          persona TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running', 'done', 'error')),
          phase TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          node_id TEXT,
          node_title TEXT,
          error TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_generation_tasks_project
          ON generation_tasks(project_id, started_at DESC);
      `)
    },
  },
  {
    version: 6,
    name: 'durable governed agent runs',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
          thread_id TEXT NOT NULL, requested_by TEXT NOT NULL, title TEXT NOT NULL,
          request TEXT NOT NULL, status TEXT NOT NULL, classification TEXT NOT NULL,
          model TEXT, skill_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, completed_at TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          kind TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL,
          occurred_at TEXT NOT NULL, UNIQUE(run_id, sequence),
          FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
          risk TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL,
          requested_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, rationale TEXT,
          FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_run_events_sequence ON run_events(run_id, sequence);
      `)
    },
  },
  {
    version: 7,
    name: 'controlled intake staging and provenance',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS intake_items (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
          filename TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL, content_base64 TEXT NOT NULL, state TEXT NOT NULL,
          suggested_classification TEXT NOT NULL, approved_classification TEXT,
          tags TEXT NOT NULL DEFAULT '[]', findings TEXT NOT NULL DEFAULT '[]',
          submitted_by TEXT NOT NULL, submitted_at TEXT NOT NULL, reviewed_by TEXT,
          reviewed_at TEXT, decision_rationale TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS artifact_provenance (
          id TEXT PRIMARY KEY, intake_item_id TEXT NOT NULL, project_id TEXT NOT NULL,
          artifact_id TEXT NOT NULL, sha256 TEXT NOT NULL, classification TEXT NOT NULL,
          released_by TEXT NOT NULL, released_at TEXT NOT NULL,
          FOREIGN KEY (intake_item_id) REFERENCES intake_items(id),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_intake_state ON intake_items(organization_id, state, submitted_at DESC);
      `)
    },
  },
  {
    version: 8,
    name: 'durable document processing and OCR settings',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_processing_jobs (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          intake_item_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK(state IN ('queued', 'processing', 'needs-input', 'complete', 'failed')),
          extraction_method TEXT,
          engine_name TEXT,
          engine_version TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (intake_item_id) REFERENCES intake_items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS document_derivatives (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          intake_item_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('text', 'metadata', 'page-map', 'thumbnail')),
          media_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          content_base64 TEXT NOT NULL,
          page_count INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(job_id, kind),
          FOREIGN KEY (intake_item_id) REFERENCES intake_items(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES document_processing_jobs(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS document_processing_settings (
          organization_id TEXT PRIMARY KEY,
          max_file_size_bytes INTEGER NOT NULL DEFAULT 26214400,
          ocr_enabled INTEGER NOT NULL DEFAULT 1,
          ocr_languages TEXT NOT NULL DEFAULT '["eng"]',
          native_text_minimum INTEGER NOT NULL DEFAULT 32,
          job_timeout_seconds INTEGER NOT NULL DEFAULT 120,
          retain_intermediates INTEGER NOT NULL DEFAULT 1,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_document_jobs_queue
          ON document_processing_jobs(organization_id, state, created_at);
        CREATE INDEX IF NOT EXISTS idx_document_derivatives_item
          ON document_derivatives(organization_id, intake_item_id);
      `)
    },
  },
  {
    version: 9,
    name: 'hardened intake security',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS intake_security_scans (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          intake_item_id TEXT NOT NULL UNIQUE,
          verdict TEXT NOT NULL CHECK(verdict IN ('checking','passed','review-required','blocked','engine-unavailable','definitions-stale')),
          clamav_version TEXT,
          clamav_definitions_at TEXT,
          yarax_version TEXT,
          rule_pack_version TEXT,
          matches_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          override_by TEXT,
          override_rationale TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (intake_item_id) REFERENCES intake_items(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS intake_security_settings (
          organization_id TEXT PRIMARY KEY,
          clamav_required INTEGER NOT NULL DEFAULT 1,
          yarax_required INTEGER NOT NULL DEFAULT 1,
          max_definition_age_hours INTEGER NOT NULL DEFAULT 72,
          archive_max_depth INTEGER NOT NULL DEFAULT 3,
          archive_max_members INTEGER NOT NULL DEFAULT 250,
          archive_max_expanded_bytes INTEGER NOT NULL DEFAULT 104857600,
          scan_timeout_seconds INTEGER NOT NULL DEFAULT 60,
          active_rule_pack_version TEXT NOT NULL DEFAULT 'builtin-1',
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_intake_security_verdict
          ON intake_security_scans(organization_id, verdict, updated_at);
      `)
    },
  },
  {
    version: 10,
    name: 'cape connection lifecycle and transfer queues',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cape_connections (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
          system_key TEXT NOT NULL, adapter_kind TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('draft','validating','active','degraded','disabled','authorization-expired')),
          mode TEXT NOT NULL DEFAULT 'simulated', credential_ref TEXT, scope_json TEXT NOT NULL DEFAULT '{}',
          mapping_json TEXT NOT NULL DEFAULT '{}', schedule_json TEXT NOT NULL DEFAULT '{}', approval_policy TEXT NOT NULL DEFAULT 'protected-writes',
          last_test_at TEXT, last_test_status TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cape_connection_queue (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, connection_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')), idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','awaiting-approval','processing','complete','failed','dead-letter')),
          payload_json TEXT NOT NULL, checkpoint_json TEXT, approval_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(connection_id,direction,idempotency_key), FOREIGN KEY(connection_id) REFERENCES cape_connections(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_cape_connections_org ON cape_connections(organization_id,lifecycle_state);
        CREATE INDEX IF NOT EXISTS idx_cape_queue_state ON cape_connection_queue(organization_id,state,created_at);
      `)
    },
  },
  {
    version: 11,
    name: 'model evaluation registry and deployment gates',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_evaluation_runs (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, model_name TEXT NOT NULL, model_digest TEXT NOT NULL,
          quantization TEXT NOT NULL, prompt_version TEXT NOT NULL, skill_version TEXT NOT NULL, tool_schema_version TEXT NOT NULL,
          dataset_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','passed','failed')),
          metrics_json TEXT NOT NULL DEFAULT '{}', policy_snapshot_json TEXT NOT NULL DEFAULT '{}', report_sha256 TEXT,
          created_by TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS model_deployment_policy (
          organization_id TEXT PRIMARY KEY, minimum_task_accuracy REAL NOT NULL DEFAULT 0.85,
          maximum_unsafe_action_rate REAL NOT NULL DEFAULT 0.0, maximum_approval_bypass_rate REAL NOT NULL DEFAULT 0.0,
          require_citations INTEGER NOT NULL DEFAULT 1, eligible_evaluation_id TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_eval_org ON model_evaluation_runs(organization_id,created_at);
      `)
    },
  },
  {
    version: 12,
    name: 'records schedules holds and disposition history',
    up(db) {
      db.exec(`
        ALTER TABLE intake_items ADD COLUMN records_schedule_id TEXT;
        CREATE TABLE IF NOT EXISTS records_schedules (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL,
          retention_months INTEGER, disposition_action TEXT NOT NULL CHECK(disposition_action IN ('destroy','transfer','review')),
          permanent INTEGER NOT NULL DEFAULT 0, effective_at TEXT NOT NULL, supersedes_id TEXT, active INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(organization_id,code,effective_at)
        );
        CREATE TABLE IF NOT EXISTS records_holds (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, scope_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','released')), rationale TEXT NOT NULL,
          created_by TEXT NOT NULL, created_at TEXT NOT NULL, released_by TEXT, released_at TEXT
        );
        CREATE TABLE IF NOT EXISTS records_disposition_history (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
          schedule_id TEXT, action TEXT NOT NULL, actor TEXT NOT NULL, rationale TEXT, evidence_hash TEXT,
          occurred_at TEXT NOT NULL, FOREIGN KEY(schedule_id) REFERENCES records_schedules(id)
        );
        CREATE INDEX IF NOT EXISTS idx_records_schedules_org ON records_schedules(organization_id,active);
        CREATE INDEX IF NOT EXISTS idx_records_holds_org ON records_holds(organization_id,state);
      `)
    },
  },
  {
    version: 13,
    name: 'deployment posture and authorization evidence',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS deployment_posture (
          organization_id TEXT PRIMARY KEY, profile TEXT NOT NULL DEFAULT 'local-development',
          identity_status TEXT NOT NULL DEFAULT 'unverified', audit_forwarding_status TEXT NOT NULL DEFAULT 'unverified',
          backup_status TEXT NOT NULL DEFAULT 'unverified', secret_store_status TEXT NOT NULL DEFAULT 'unverified',
          time_sync_status TEXT NOT NULL DEFAULT 'unverified', authorization_status TEXT NOT NULL DEFAULT 'not-authorized',
          inherited_controls_json TEXT NOT NULL DEFAULT '[]', customer_controls_json TEXT NOT NULL DEFAULT '[]',
          updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS authorization_evidence_bundles (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, profile TEXT NOT NULL, manifest_json TEXT NOT NULL,
          sha256 TEXT NOT NULL, signature_status TEXT NOT NULL DEFAULT 'unsigned', created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_evidence_org ON authorization_evidence_bundles(organization_id,created_at);
      `)
    },
  },
  {
    version: 14,
    name: 'complete run workspace persistence',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_messages (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS run_plans (
          run_id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS tool_sessions (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
          status TEXT NOT NULL, classification TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
          takeover_by TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
          FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_run_messages_time ON run_messages(run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_tool_sessions_run ON tool_sessions(run_id, updated_at DESC);
      `)
      addColumn(db, 'approval_requests', 'event_id TEXT')
      addColumn(db, 'approval_requests', 'modification_json TEXT')
    },
  },
  {
    version: 15,
    name: 'local model runtime settings',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_runtime_settings (
          organization_id TEXT PRIMARY KEY,
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
    },
  },
  {
    version: 16,
    name: 'pin local inference to LFM2.5-2.6B',
    up(db) {
      db.prepare('UPDATE model_runtime_settings SET model = ?').run('LiquidAI/LFM2.5-2.6B')
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
