import { createHash, randomUUID } from 'node:crypto'
import type { AgentDatabase } from '../database.js'
import type { ContentSource, ExtractOffset } from '../web/extract.js'

type Row = Record<string, unknown>

/**
 * Durable record of what a device page said, and of what an approved action is
 * therefore allowed to send.
 *
 * Two tables, and the reason for the second is the approval. A proposal is signed
 * against the page it was read from; if the only copy of that page lived in the
 * model's context, an operator could approve one form and the executor could be
 * handed a different one. So the read writes an immutable snapshot with a content
 * hash, the write intent references that snapshot, and the executor refuses to run
 * unless the snapshot it re-reads matches the hash the human approved.
 */

export interface ConsolePageRecord {
  id: string
  integrationId: string
  url: string
  finalUrl: string
  status: number
  mediaType: string
  /**
   * `served` for bytes that came off the wire, `rendered` for a browser's
   * serialization of the post-script DOM. `sha256` hashes whichever one was
   * recorded, so a rendered snapshot's hash will not match the HTTP response and
   * no comparison should be made as if it would.
   */
  source: ContentSource
  sha256: string
  title: string
  bytes: number
  createdAt: string
  structure: ConsoleStructure
}

export interface ConsoleStructureField {
  name: string
  type: string
  value: string | null
  offset: ExtractOffset
  formId?: string
}

export interface ConsoleStructureForm {
  id: string
  action: string
  method: string
  enctype: string
  fields: ConsoleStructureField[]
  offset: ExtractOffset
}

export interface ConsoleStructure {
  forms: ConsoleStructureForm[]
  headings: Array<{ text: string; offset: ExtractOffset }>
  machineContentRemoved: number
}

export type ConsoleSubmissionState = 'proposed' | 'released' | 'consumed' | 'void'

/**
 * Which approved action a submission is bound for.
 *
 * Stored, never inferred. A policy form on an appliance routinely contains a
 * password control alongside the rule being changed, so "has a secret field" does
 * not mean "this is a login", and getting that wrong would run a different state
 * change than the one an operator read.
 */
export type ConsoleSubmissionKind = 'login' | 'form'

export interface ConsoleSubmissionRecord {
  id: string
  kind: ConsoleSubmissionKind
  pageId: string
  integrationId: string
  formId: string
  method: string
  url: string
  enctype: string
  /**
   * Values the operator approved, in the form's own document order. Secret material
   * is never here: a password is recorded as `null` and filled at release time.
   *
   * `role` marks which control a login submits as the account name and which as the
   * secret, so the executor does not have to infer either from a value pattern.
   */
  parameters: Array<{ name: string; value: string | null; role?: 'user' | 'secret' }>
  pageSha256: string
  state: ConsoleSubmissionState
  createdAt: string
  releasedAt?: string
}

export class ConsoleStore {
  constructor(private readonly db: AgentDatabase) {
    this.migrate()
  }

  recordPage(input: {
    integrationId: string
    url: string
    finalUrl: string
    status: number
    mediaType: string
    body: string
    title?: string
    structure: ConsoleStructure
    /** Defaults to `served`; a rendered frame must say so explicitly. */
    source?: ContentSource
  }): ConsolePageRecord {
    const sha256 = createHash('sha256').update(input.body, 'utf8').digest('hex')
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO agent_console_pages(
      id,integration_id,url,final_url,status,media_type,sha256,title,bytes,structure_json,created_at,source
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.integrationId,
      input.url,
      input.finalUrl,
      input.status,
      input.mediaType,
      sha256,
      input.title ?? '',
      Buffer.byteLength(input.body, 'utf8'),
      JSON.stringify(input.structure),
      new Date().toISOString(),
      input.source ?? 'served',
    )
    return this.getPage(id) as ConsolePageRecord
  }

  getPage(id: string): ConsolePageRecord | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_console_pages WHERE id=?').get(id) as Row | undefined
    return row ? this.page(row) : undefined
  }

  createSubmission(input: {
    kind: ConsoleSubmissionKind
    pageId: string
    integrationId: string
    formId: string
    method: string
    url: string
    enctype: string
    parameters: Array<{ name: string; value: string | null; role?: 'user' | 'secret' }>
    pageSha256: string
  }): ConsoleSubmissionRecord {
    const page = this.getPage(input.pageId)
    if (!page) throw new Error('Cannot record a device action against an unknown page snapshot')
    if (page.sha256 !== input.pageSha256) throw new Error('Cannot record a device action: the page hash does not match the snapshot')
    // Secondary net. The primary guard is that the reader never captures a value
    // from a password-typed control; this catches anything that reaches the store
    // with one anyway. A CSRF or page token is deliberately NOT in this list: on an
    // appliance those values must be carried and re-sent, and refusing them would
    // break every real submission without protecting anything.
    const secretShaped = /pass(word|wd)?|secret|private[-_]?key|api[-_]?key|^pwd$/i
    if (input.parameters.some((parameter) => secretShaped.test(parameter.name) && (parameter.value ?? '').length > 0)) {
      throw new Error('A device action parameter must not carry a password or secret value')
    }
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO agent_console_submissions(
      id,kind,page_id,integration_id,form_id,method,url,enctype,parameters_json,page_sha256,state,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.kind,
      input.pageId,
      input.integrationId,
      input.formId,
      input.method.toUpperCase(),
      input.url,
      input.enctype,
      JSON.stringify(input.parameters),
      input.pageSha256,
      'proposed',
      new Date().toISOString(),
    )
    return this.getSubmission(id) as ConsoleSubmissionRecord
  }

  getSubmission(id: string): ConsoleSubmissionRecord | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_console_submissions WHERE id=?').get(id) as Row | undefined
    return row ? this.submission(row) : undefined
  }

  /**
   * Move a submission forward, and only forward.
   *
   * The executor claims `proposed → released` before it touches the device, so a
   * retry after a partial failure cannot send the same state change twice, and a
   * row that is already `consumed` can never be replayed by anything.
   */
  transitionSubmission(id: string, from: ConsoleSubmissionState[], to: ConsoleSubmissionState): ConsoleSubmissionRecord {
    const current = this.getSubmission(id)
    if (!current) throw new Error('Device action submission not found')
    if (!from.includes(current.state)) throw new Error(`Device action submission ${id} is ${current.state}, not ${from.join(' or ')}`)
    const now = new Date().toISOString()
    if (to === 'released') {
      this.db.sqlite.prepare("UPDATE agent_console_submissions SET state='released',released_at=? WHERE id=? AND state IN ('proposed')").run(now, id)
    } else {
      this.db.sqlite.prepare('UPDATE agent_console_submissions SET state=? WHERE id=?').run(to, id)
    }
    return this.getSubmission(id) as ConsoleSubmissionRecord
  }

  private page(row: Row): ConsolePageRecord {
    let structure: ConsoleStructure = { forms: [], headings: [], machineContentRemoved: 0 }
    try {
      const parsed = JSON.parse(String(row.structure_json ?? '{}')) as Partial<ConsoleStructure>
      structure = {
        forms: Array.isArray(parsed.forms) ? parsed.forms : [],
        headings: Array.isArray(parsed.headings) ? parsed.headings : [],
        machineContentRemoved: typeof parsed.machineContentRemoved === 'number' ? parsed.machineContentRemoved : 0,
      }
    } catch {
      // A snapshot whose structure will not parse is still evidence of the bytes.
    }
    return {
      id: String(row.id),
      integrationId: String(row.integration_id),
      url: String(row.url),
      finalUrl: String(row.final_url),
      status: Number(row.status),
      mediaType: String(row.media_type),
      sha256: String(row.sha256),
      title: String(row.title ?? ''),
      bytes: Number(row.bytes),
      createdAt: String(row.created_at),
      // A row written before the column existed reads back as NULL, and NULL means
      // the only thing the old code could ever have recorded.
      source: row.source === 'rendered' ? 'rendered' : 'served',
      structure,
    }
  }

  private submission(row: Row): ConsoleSubmissionRecord {
    let parameters: Array<{ name: string; value: string | null; role?: 'user' | 'secret' }> = []
    try {
      const parsed = JSON.parse(String(row.parameters_json ?? '[]')) as unknown
      if (Array.isArray(parsed)) {
        parameters = parsed.flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const record = item as { name?: unknown; value?: unknown; role?: unknown }
          if (typeof record.name !== 'string') return []
          const value = typeof record.value === 'string' ? record.value : null
          const role = record.role === 'user' || record.role === 'secret' ? record.role : undefined
          return [{ name: record.name, value, ...(role ? { role } : {}) }]
        })
      }
    } catch {
      parameters = []
    }
    return {
      id: String(row.id),
      kind: (String(row.kind) === 'login' ? 'login' : 'form') as ConsoleSubmissionKind,
      pageId: String(row.page_id),
      integrationId: String(row.integration_id),
      formId: String(row.form_id),
      method: String(row.method),
      url: String(row.url),
      enctype: String(row.enctype),
      parameters,
      pageSha256: String(row.page_sha256),
      state: String(row.state) as ConsoleSubmissionState,
      createdAt: String(row.created_at),
      ...(row.released_at ? { releasedAt: String(row.released_at) } : {}),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_console_pages (
        id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        status INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL,
        structure_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'served'
      );
      CREATE INDEX IF NOT EXISTS agent_console_pages_integration ON agent_console_pages(integration_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_console_submissions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('login','form')),
        page_id TEXT NOT NULL REFERENCES agent_console_pages(id),
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        form_id TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        enctype TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        page_sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('proposed','released','consumed','void')),
        created_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_console_submissions_page ON agent_console_submissions(page_id,created_at DESC);
      -- Snapshots are the evidence behind an approval. Deleting one would let a
      -- later page impersonate the page a human said yes to.
      CREATE TRIGGER IF NOT EXISTS agent_console_pages_no_delete BEFORE DELETE ON agent_console_pages
      BEGIN SELECT RAISE(ABORT, 'device page snapshots are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_console_pages_no_update BEFORE UPDATE ON agent_console_pages
      BEGIN SELECT RAISE(ABORT, 'device page snapshots are append-only'); END;
    `)
    this.ensureColumn('agent_console_submissions', 'released_at', 'TEXT')
    // Pages gained `source` after the fact. Submissions deliberately do not carry
    // one: a submission already points at its page snapshot, and storing the same
    // fact twice is how the two halves get to disagree. Whoever releases an action
    // reads the source off the page it was proposed from.
    this.ensureColumn('agent_console_pages', 'source', "TEXT NOT NULL DEFAULT 'served'")
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!columns.some((candidate) => candidate.name === column)) this.db.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
