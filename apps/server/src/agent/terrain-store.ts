import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentObservation,
  IntegrationConfiguration,
  ObservationInput,
  SyncCheckpoint,
  SyncJob,
  TerrainEntity,
  TerrainEntityInput,
  TerrainRelationship,
  TerrainRelationshipInput,
  TerrainSnapshot,
} from '@papyrus/contracts'
import { canonical, AgentDatabase } from './database.js'

type Row = Record<string, unknown>

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  return JSON.parse(String(value)) as Record<string, unknown>
}

function mergeRecord(current: unknown, next: Record<string, unknown> | undefined): string {
  return JSON.stringify({ ...parseRecord(current), ...(next ?? {}) })
}

export interface IngestResult {
  observation: AgentObservation
  created: boolean
  entities: number
  relationships: number
}

export class SourceRecordConflictError extends Error {
  constructor() { super('The source record identifier was already used with different content') }
}

export class TerrainStore {
  constructor(readonly db: AgentDatabase) { this.migrate() }

  ingest(integration: IntegrationConfiguration, input: ObservationInput): IngestResult {
    const receivedAt = new Date().toISOString()
    const contentHash = digest({
      sourceIntegrationId: integration.id,
      sourceRecordId: input.sourceRecordId,
      observedAt: input.observedAt,
      ...(input.schema ? { schema: input.schema } : {}),
      evidenceType: input.evidenceType,
      subject: input.subject,
      classification: input.classification ?? null,
      payload: input.payload,
      terrain: input.terrain ?? null,
    })
    const existing = this.db.sqlite.prepare('SELECT * FROM agent_observations WHERE integration_id=? AND source_record_id=?')
      .get(integration.id, input.sourceRecordId) as Row | undefined
    if (existing) {
      if (String(existing.sha256) !== contentHash) throw new SourceRecordConflictError()
      return { observation: this.observation(existing), created: false, entities: 0, relationships: 0 }
    }

    const observationId = randomUUID()
    let entityCount = 0
    let relationshipCount = 0
    this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare(`INSERT INTO agent_observations(
        id,integration_id,source_record_id,observed_at,received_at,schema,evidence_type,subject,classification,payload_json,terrain_json,sha256,processed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        observationId, integration.id, input.sourceRecordId, input.observedAt, receivedAt, input.schema ?? null, input.evidenceType,
        input.subject, input.classification ?? null, JSON.stringify(input.payload), JSON.stringify(input.terrain ?? null), contentHash, receivedAt,
      )
      const terrain = input.terrain
      if (terrain) {
        const entityIds = new Map(terrain.entities.map((entity) => [entity.externalId, this.upsertEntity(entity, input.observedAt, integration.id, observationId)]))
        entityCount = entityIds.size
        for (const relationship of terrain.relationships ?? []) {
          const sourceId = entityIds.get(relationship.sourceExternalId) ?? this.entityId(relationship.sourceExternalId)
          const targetId = entityIds.get(relationship.targetExternalId) ?? this.entityId(relationship.targetExternalId)
          if (!this.hasEntity(sourceId) || !this.hasEntity(targetId)) throw new Error(`Terrain relationship ${relationship.kind} references an unknown entity`)
          this.upsertRelationship(relationship, sourceId, targetId, input.observedAt, integration.id, observationId)
          relationshipCount += 1
        }
      }
    })()
    this.db.recordEvidence(integration.id, input.observedAt)
    return {
      observation: this.getObservation(observationId) as AgentObservation,
      created: true,
      entities: entityCount,
      relationships: relationshipCount,
    }
  }

  snapshot(): TerrainSnapshot {
    const entities = (this.db.sqlite.prepare('SELECT * FROM terrain_entities ORDER BY kind,label,id').all() as Row[]).map((row) => this.entity(row))
    const relationships = (this.db.sqlite.prepare('SELECT * FROM terrain_relationships ORDER BY kind,id').all() as Row[]).map((row) => this.relationship(row))
    const count = this.db.sqlite.prepare('SELECT count(*) count FROM agent_observations').get() as Row
    return {
      generatedAt: new Date().toISOString(), entities, relationships,
      observationCount: Number(count.count ?? 0), unresolvedClaims: 0,
    }
  }

  getObservation(id: string): AgentObservation | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_observations WHERE id=?').get(id) as Row | undefined
    return row ? this.observation(row) : undefined
  }

  enqueueSync(integrationId: string, runAfter = new Date().toISOString()): SyncJob {
    const now = new Date().toISOString()
    this.db.sqlite.prepare(`INSERT OR IGNORE INTO agent_sync_jobs(
      id,integration_id,status,attempt,run_after,created_at,updated_at
    ) VALUES(?,?,'queued',0,?,?,?)`).run(randomUUID(), integrationId, runAfter, now, now)
    const row = this.db.sqlite.prepare("SELECT * FROM agent_sync_jobs WHERE integration_id=? AND status IN ('queued','running') ORDER BY created_at LIMIT 1")
      .get(integrationId) as Row
    return this.job(row)
  }

  cancelSync(integrationId: string): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE agent_sync_jobs SET status='cancelled',completed_at=?,updated_at=?,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL WHERE integration_id=? AND status IN ('queued','running')")
      .run(now, now, integrationId)
  }

  claimSync(workerId: string, leaseMs: number, now = new Date()): SyncJob | undefined {
    const timestamp = now.toISOString()
    const expiredBefore = timestamp
    return this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare(`UPDATE agent_sync_jobs SET status='queued',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=?
        WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`).run(timestamp, expiredBefore)
      const candidate = this.db.sqlite.prepare("SELECT id FROM agent_sync_jobs WHERE status='queued' AND run_after<=? ORDER BY run_after,created_at LIMIT 1")
        .get(timestamp) as Row | undefined
      if (!candidate) return undefined
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
      const result = this.db.sqlite.prepare(`UPDATE agent_sync_jobs SET status='running',attempt=attempt+1,locked_by=?,locked_at=?,
        lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='queued'`)
        .run(workerId, timestamp, leaseExpiresAt, timestamp, timestamp, String(candidate.id))
      if (result.changes !== 1) return undefined
      return this.job(this.db.sqlite.prepare('SELECT * FROM agent_sync_jobs WHERE id=?').get(String(candidate.id)) as Row)
    })()
  }

  completeSync(jobId: string): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE agent_sync_jobs SET status='completed',completed_at=?,updated_at=?,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,error=NULL WHERE id=? AND status='running'")
      .run(now, now, jobId)
  }

  retrySync(jobId: string, error: string, runAfter: string, terminal: boolean): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare(`UPDATE agent_sync_jobs SET status=?,run_after=?,completed_at=?,updated_at=?,error=?,
      locked_by=NULL,locked_at=NULL,lease_expires_at=NULL WHERE id=? AND status='running'`).run(
        terminal ? 'failed' : 'queued', runAfter, terminal ? now : null, now, error.slice(0, 2048), jobId,
      )
  }

  checkpoint(integrationId: string): SyncCheckpoint | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_sync_checkpoints WHERE integration_id=?').get(integrationId) as Row | undefined
    return row ? {
      integrationId: String(row.integration_id), ...(row.cursor ? { cursor: String(row.cursor) } : {}), updatedAt: String(row.updated_at),
    } : undefined
  }

  saveCheckpoint(integrationId: string, cursor: string | undefined): void {
    this.db.sqlite.prepare(`INSERT INTO agent_sync_checkpoints(integration_id,cursor,updated_at) VALUES(?,?,?)
      ON CONFLICT(integration_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`)
      .run(integrationId, cursor ?? null, new Date().toISOString())
  }

  listJobs(integrationId: string): SyncJob[] {
    return (this.db.sqlite.prepare('SELECT * FROM agent_sync_jobs WHERE integration_id=? ORDER BY created_at DESC').all(integrationId) as Row[])
      .map((row) => this.job(row))
  }

  private upsertEntity(input: TerrainEntityInput, observedAt: string, integrationId: string, observationId: string): string {
    const id = this.entityId(input.externalId)
    const current = this.db.sqlite.prepare('SELECT attributes_json FROM terrain_entities WHERE id=?').get(id) as Row | undefined
    this.db.sqlite.prepare(`INSERT INTO terrain_entities(id,external_id,kind,label,attributes_json,confidence,first_seen,last_seen)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind,label=excluded.label,attributes_json=excluded.attributes_json,
      confidence=max(terrain_entities.confidence,excluded.confidence),
      first_seen=min(terrain_entities.first_seen,excluded.first_seen),last_seen=max(terrain_entities.last_seen,excluded.last_seen)`)
      .run(id, input.externalId, input.kind, input.label, mergeRecord(current?.attributes_json, input.attributes), input.confidence ?? 1, observedAt, observedAt)
    this.db.sqlite.prepare('INSERT OR IGNORE INTO terrain_entity_evidence(entity_id,observation_id,integration_id) VALUES(?,?,?)')
      .run(id, observationId, integrationId)
    return id
  }

  private upsertRelationship(input: TerrainRelationshipInput, sourceId: string, targetId: string, observedAt: string, integrationId: string, observationId: string): string {
    const externalId = input.externalId ?? `${input.kind}:${input.sourceExternalId}:${input.targetExternalId}`
    const id = digest(`relationship:${externalId}`)
    const current = this.db.sqlite.prepare('SELECT attributes_json FROM terrain_relationships WHERE id=?').get(id) as Row | undefined
    this.db.sqlite.prepare(`INSERT INTO terrain_relationships(id,external_id,kind,source_entity_id,target_entity_id,attributes_json,confidence,first_seen,last_seen)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind,source_entity_id=excluded.source_entity_id,target_entity_id=excluded.target_entity_id,
      attributes_json=excluded.attributes_json,confidence=max(terrain_relationships.confidence,excluded.confidence),
      first_seen=min(terrain_relationships.first_seen,excluded.first_seen),last_seen=max(terrain_relationships.last_seen,excluded.last_seen)`)
      .run(id, externalId, input.kind, sourceId, targetId, mergeRecord(current?.attributes_json, input.attributes), input.confidence ?? 1, observedAt, observedAt)
    this.db.sqlite.prepare('INSERT OR IGNORE INTO terrain_relationship_evidence(relationship_id,observation_id,integration_id) VALUES(?,?,?)')
      .run(id, observationId, integrationId)
    return id
  }

  private entityId(externalId: string): string { return digest(`entity:${externalId}`) }
  private hasEntity(id: string): boolean { return Boolean(this.db.sqlite.prepare('SELECT 1 FROM terrain_entities WHERE id=?').get(id)) }

  private observation(row: Row): AgentObservation {
    return {
      id: String(row.id), sourceIntegrationId: String(row.integration_id), sourceRecordId: String(row.source_record_id),
      observedAt: String(row.observed_at), receivedAt: String(row.received_at), ...(row.schema ? { schema: String(row.schema) } : {}),
      evidenceType: String(row.evidence_type), subject: String(row.subject),
      ...(row.classification ? { classification: String(row.classification) } : {}), payload: parseRecord(row.payload_json),
      provenance: { sourceRecordId: String(row.source_record_id), sha256: String(row.sha256) },
      ...(row.processed_at ? { processedAt: String(row.processed_at) } : {}),
    }
  }

  private entity(row: Row): TerrainEntity {
    const provenance = this.db.sqlite.prepare('SELECT integration_id,observation_id FROM terrain_entity_evidence WHERE entity_id=? ORDER BY integration_id,observation_id')
      .all(String(row.id)) as Row[]
    return {
      id: String(row.id), externalId: String(row.external_id), kind: String(row.kind), label: String(row.label),
      attributes: parseRecord(row.attributes_json), confidence: Number(row.confidence), firstSeen: String(row.first_seen), lastSeen: String(row.last_seen),
      sourceIntegrationIds: [...new Set(provenance.map((entry) => String(entry.integration_id)))],
      evidenceIds: provenance.map((entry) => String(entry.observation_id)),
    }
  }

  private relationship(row: Row): TerrainRelationship {
    const provenance = this.db.sqlite.prepare('SELECT integration_id,observation_id FROM terrain_relationship_evidence WHERE relationship_id=? ORDER BY integration_id,observation_id')
      .all(String(row.id)) as Row[]
    return {
      id: String(row.id), externalId: String(row.external_id), kind: String(row.kind), sourceId: String(row.source_entity_id), targetId: String(row.target_entity_id),
      attributes: parseRecord(row.attributes_json), confidence: Number(row.confidence), firstSeen: String(row.first_seen), lastSeen: String(row.last_seen),
      sourceIntegrationIds: [...new Set(provenance.map((entry) => String(entry.integration_id)))],
      evidenceIds: provenance.map((entry) => String(entry.observation_id)),
    }
  }

  private job(row: Row): SyncJob {
    return {
      id: String(row.id), integrationId: String(row.integration_id), status: row.status as SyncJob['status'], attempt: Number(row.attempt),
      runAfter: String(row.run_after), ...(row.locked_by ? { lockedBy: String(row.locked_by) } : {}), ...(row.locked_at ? { lockedAt: String(row.locked_at) } : {}),
      ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.error ? { error: String(row.error) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_observations (
        id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        source_record_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        schema TEXT,
        evidence_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        classification TEXT,
        payload_json TEXT NOT NULL,
        terrain_json TEXT,
        sha256 TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(integration_id,source_record_id)
      );
      CREATE INDEX IF NOT EXISTS agent_observations_received ON agent_observations(received_at DESC);
      CREATE TRIGGER IF NOT EXISTS agent_observations_no_update BEFORE UPDATE ON agent_observations
      BEGIN SELECT RAISE(ABORT, 'agent observations are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_observations_no_delete BEFORE DELETE ON agent_observations
      BEGIN SELECT RAISE(ABORT, 'agent observations are append-only'); END;
      CREATE TABLE IF NOT EXISTS terrain_entities (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terrain_relationships (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        source_entity_id TEXT NOT NULL REFERENCES terrain_entities(id),
        target_entity_id TEXT NOT NULL REFERENCES terrain_entities(id),
        attributes_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS terrain_relationships_source ON terrain_relationships(source_entity_id);
      CREATE INDEX IF NOT EXISTS terrain_relationships_target ON terrain_relationships(target_entity_id);
      CREATE TABLE IF NOT EXISTS terrain_entity_evidence (
        entity_id TEXT NOT NULL REFERENCES terrain_entities(id),
        observation_id TEXT NOT NULL REFERENCES agent_observations(id),
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        PRIMARY KEY(entity_id,observation_id)
      );
      CREATE TABLE IF NOT EXISTS terrain_relationship_evidence (
        relationship_id TEXT NOT NULL REFERENCES terrain_relationships(id),
        observation_id TEXT NOT NULL REFERENCES agent_observations(id),
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        PRIMARY KEY(relationship_id,observation_id)
      );
      CREATE TABLE IF NOT EXISTS agent_sync_checkpoints (
        integration_id TEXT PRIMARY KEY REFERENCES agent_integrations(id),
        cursor TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sync_jobs (
        id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        attempt INTEGER NOT NULL,
        run_after TEXT NOT NULL,
        locked_by TEXT,
        locked_at TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sync_jobs_ready ON agent_sync_jobs(status,run_after,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS agent_sync_jobs_one_active ON agent_sync_jobs(integration_id) WHERE status IN ('queued','running');
    `)
    this.ensureColumn('agent_observations', 'schema', 'TEXT')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!columns.some((candidate) => candidate.name === column)) this.db.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
