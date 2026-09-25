import { randomUUID } from 'node:crypto'
import type { AgentDatabase } from '../database.js'

export type WorkItemStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'done' | 'failed' | 'cancelled'
export type WorkItemSpecialist = 'papyrus' | 'evidence' | 'artifact' | 'operations' | 'console' | 'acp'

export interface WorkItem {
  id: string
  sessionId: string
  actorOid: string
  title: string
  description?: string
  status: WorkItemStatus
  specialist: WorkItemSpecialist
  dependencies: string[]
  evidence: Array<{ kind: string; ref: string; note?: string }>
  result?: string
  blocker?: string
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface SessionFact {
  id: string
  sessionId: string
  actorOid: string
  key: string
  value: string
  source: 'operator' | 'agent' | 'system'
  createdAt: string
  updatedAt: string
}

export interface SessionEvent {
  sequence: number
  sessionId: string
  actorOid: string
  kind: string
  payload: Record<string, unknown>
  createdAt: string
}

type Row = Record<string, unknown>

/**
 * Durable execution state beside Mastra memory.
 *
 * Conversation memory answers "what was said". This graph answers "what work
 * still exists, what did it depend on, and what evidence proves it finished".
 * The two stay deliberately separate so pruning chat history cannot erase task
 * state and a model cannot make a completed node disappear by summarising it.
 */
export class WorkGraphStore {
  constructor(private readonly db: AgentDatabase) { this.migrate() }

  create(sessionId: string, actorOid: string, input: {
    title: string
    description?: string
    specialist?: WorkItemSpecialist
    dependencies?: string[]
  }): WorkItem {
    const now = new Date().toISOString()
    const id = randomUUID()
    const dependencies = [...new Set(input.dependencies ?? [])].filter(Boolean)
    for (const dependency of dependencies) {
      const item = this.get(dependency, sessionId, actorOid)
      if (!item) throw new Error(`Work dependency ${dependency} is not in this session`)
    }
    this.db.sqlite.prepare(`INSERT INTO agent_work_items(
      id,session_id,actor_oid,title,description,status,specialist,dependencies_json,evidence_json,result,blocker,attempts,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, sessionId, actorOid, input.title.trim().slice(0, 240), input.description?.trim().slice(0, 8000) ?? null,
      'queued', input.specialist ?? 'papyrus', JSON.stringify(dependencies), '[]', null, null, 0, now, now,
    )
    this.appendEvent(sessionId, actorOid, 'work.created', { workItemId: id, title: input.title, specialist: input.specialist ?? 'papyrus' })
    return this.get(id, sessionId, actorOid) as WorkItem
  }

  get(id: string, sessionId: string, actorOid: string): WorkItem | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_work_items WHERE id=? AND session_id=? AND actor_oid=?')
      .get(id, sessionId, actorOid) as Row | undefined
    return row ? this.item(row) : undefined
  }

  list(sessionId: string, actorOid: string): WorkItem[] {
    return (this.db.sqlite.prepare('SELECT * FROM agent_work_items WHERE session_id=? AND actor_oid=? ORDER BY created_at ASC')
      .all(sessionId, actorOid) as Row[]).map((row) => this.item(row))
  }

  ready(sessionId: string, actorOid: string): WorkItem[] {
    const items = this.list(sessionId, actorOid)
    const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.id))
    return items.filter((item) => item.status === 'queued' && item.dependencies.every((dependency) => done.has(dependency)))
  }

  update(sessionId: string, actorOid: string, id: string, patch: {
    status?: WorkItemStatus
    result?: string
    blocker?: string
    evidence?: Array<{ kind: string; ref: string; note?: string }>
    incrementAttempts?: boolean
  }): WorkItem {
    const current = this.get(id, sessionId, actorOid)
    if (!current) throw new Error('Work item not found in this session')
    const now = new Date().toISOString()
    const evidence = patch.evidence ? mergeEvidence(current.evidence, patch.evidence) : current.evidence
    const status = patch.status ?? current.status
    const attempts = current.attempts + (patch.incrementAttempts ? 1 : 0)
    this.db.sqlite.prepare(`UPDATE agent_work_items SET
      status=?,evidence_json=?,result=?,blocker=?,attempts=?,updated_at=?
      WHERE id=? AND session_id=? AND actor_oid=?`).run(
      status, JSON.stringify(evidence), patch.result ?? current.result ?? null,
      patch.blocker === undefined ? current.blocker ?? null : (patch.blocker || null), attempts, now,
      id, sessionId, actorOid,
    )
    this.appendEvent(sessionId, actorOid, 'work.updated', {
      workItemId: id,
      status,
      attempts,
      evidenceCount: evidence.length,
      ...(patch.blocker ? { blocker: patch.blocker.slice(0, 500) } : {}),
    })
    return this.get(id, sessionId, actorOid) as WorkItem
  }

  cancelOpen(sessionId: string, actorOid: string, reason = 'Operator cancelled the active objective'): number {
    const now = new Date().toISOString()
    const result = this.db.sqlite.prepare(`UPDATE agent_work_items
      SET status='cancelled',blocker=?,updated_at=?
      WHERE session_id=? AND actor_oid=? AND status IN ('queued','running','waiting','blocked')`)
      .run(reason.slice(0, 1200), now, sessionId, actorOid)
    if (result.changes > 0) this.appendEvent(sessionId, actorOid, 'work.cancelled', { count: result.changes, reason: reason.slice(0, 500) })
    return result.changes
  }

  rememberFact(sessionId: string, actorOid: string, key: string, value: string, source: SessionFact['source']): SessionFact {
    const normalized = key.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 120)
    if (!normalized) throw new Error('Session fact key is required')
    const now = new Date().toISOString()
    const existing = this.db.sqlite.prepare('SELECT id,created_at FROM agent_session_facts WHERE session_id=? AND actor_oid=? AND key=?')
      .get(sessionId, actorOid, normalized) as Row | undefined
    const id = existing ? String(existing['id']) : randomUUID()
    this.db.sqlite.prepare(`INSERT INTO agent_session_facts(id,session_id,actor_oid,key,value,source,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,actor_oid,key) DO UPDATE SET value=excluded.value,source=excluded.source,updated_at=excluded.updated_at`)
      .run(id, sessionId, actorOid, normalized, value.trim().slice(0, 8000), source, existing ? String(existing['created_at']) : now, now)
    this.appendEvent(sessionId, actorOid, 'fact.remembered', { key: normalized, source })
    return this.fact(this.db.sqlite.prepare('SELECT * FROM agent_session_facts WHERE session_id=? AND actor_oid=? AND key=?')
      .get(sessionId, actorOid, normalized) as Row)
  }

  forgetFact(sessionId: string, actorOid: string, key: string): boolean {
    const result = this.db.sqlite.prepare('DELETE FROM agent_session_facts WHERE session_id=? AND actor_oid=? AND key=?')
      .run(sessionId, actorOid, key)
    if (result.changes > 0) this.appendEvent(sessionId, actorOid, 'fact.forgotten', { key })
    return result.changes > 0
  }

  facts(sessionId: string, actorOid: string): SessionFact[] {
    return (this.db.sqlite.prepare('SELECT * FROM agent_session_facts WHERE session_id=? AND actor_oid=? ORDER BY updated_at DESC')
      .all(sessionId, actorOid) as Row[]).map((row) => this.fact(row))
  }

  appendEvent(sessionId: string, actorOid: string, kind: string, payload: Record<string, unknown> = {}): SessionEvent {
    const now = new Date().toISOString()
    const result = this.db.sqlite.prepare('INSERT INTO agent_session_events(session_id,actor_oid,kind,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(sessionId, actorOid, kind.slice(0, 160), JSON.stringify(payload), now)
    const sequence = Number(result.lastInsertRowid)
    return { sequence, sessionId, actorOid, kind, payload, createdAt: now }
  }

  events(sessionId: string, actorOid: string, after = 0, limit = 200): SessionEvent[] {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)))
    return (this.db.sqlite.prepare(`SELECT sequence,session_id,actor_oid,kind,payload_json,created_at
      FROM agent_session_events WHERE session_id=? AND actor_oid=? AND sequence>? ORDER BY sequence ASC LIMIT ?`)
      .all(sessionId, actorOid, Math.max(0, Math.floor(after)), bounded) as Row[]).map((row) => ({
        sequence: Number(row['sequence']),
        sessionId: String(row['session_id']),
        actorOid: String(row['actor_oid']),
        kind: String(row['kind']),
        payload: parseObject(row['payload_json']),
        createdAt: String(row['created_at']),
      }))
  }

  summary(sessionId: string, actorOid: string) {
    const items = this.list(sessionId, actorOid)
    const byStatus = Object.fromEntries(['queued', 'running', 'waiting', 'blocked', 'done', 'failed', 'cancelled']
      .map((status) => [status, items.filter((item) => item.status === status).length]))
    return {
      total: items.length,
      byStatus,
      ready: this.ready(sessionId, actorOid).map((item) => item.id),
      items,
    }
  }

  private item(row: Row): WorkItem {
    return {
      id: String(row['id']),
      sessionId: String(row['session_id']),
      actorOid: String(row['actor_oid']),
      title: String(row['title']),
      ...(row['description'] ? { description: String(row['description']) } : {}),
      status: String(row['status']) as WorkItemStatus,
      specialist: String(row['specialist'] ?? 'papyrus') as WorkItemSpecialist,
      dependencies: parseStrings(row['dependencies_json']),
      evidence: parseEvidence(row['evidence_json']),
      ...(row['result'] ? { result: String(row['result']) } : {}),
      ...(row['blocker'] ? { blocker: String(row['blocker']) } : {}),
      attempts: Number(row['attempts'] ?? 0),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    }
  }

  private fact(row: Row): SessionFact {
    return {
      id: String(row['id']),
      sessionId: String(row['session_id']),
      actorOid: String(row['actor_oid']),
      key: String(row['key']),
      value: String(row['value']),
      source: String(row['source']) as SessionFact['source'],
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_work_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor_oid TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        specialist TEXT NOT NULL,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        result TEXT,
        blocker TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_work_scope ON agent_work_items(session_id,actor_oid,created_at);

      CREATE TABLE IF NOT EXISTS agent_session_facts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        actor_oid TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id,actor_oid,key)
      );

      CREATE TABLE IF NOT EXISTS agent_session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        actor_oid TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_event_scope ON agent_session_events(session_id,actor_oid,sequence);
    `)
  }
}

function mergeEvidence(
  current: WorkItem['evidence'],
  additions: WorkItem['evidence'],
): WorkItem['evidence'] {
  const merged = new Map<string, WorkItem['evidence'][number]>()
  for (const item of [...current, ...additions]) {
    if (!item?.kind || !item?.ref) continue
    merged.set(`${item.kind}:${item.ref}`, {
      kind: String(item.kind).slice(0, 80),
      ref: String(item.ref).slice(0, 1000),
      ...(item.note ? { note: String(item.note).slice(0, 2000) } : {}),
    })
  }
  return [...merged.values()].slice(0, 100)
}

function parseStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

function parseEvidence(value: unknown): WorkItem['evidence'] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>)['kind'] === 'string' && typeof (item as Record<string, unknown>)['ref'] === 'string'
      ? [{
          kind: String((item as Record<string, unknown>)['kind']),
          ref: String((item as Record<string, unknown>)['ref']),
          ...(typeof (item as Record<string, unknown>)['note'] === 'string' ? { note: String((item as Record<string, unknown>)['note']) } : {}),
        }]
      : [])
  } catch { return [] }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}
