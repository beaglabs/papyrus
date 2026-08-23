import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { ApprovedSource, ApprovedSourceKind, SourceSearchResult } from '@papyrus/contracts'
import type { PapyrusDatabase } from './db.js'

type Row = Record<string, unknown>
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.htm', '.log'])

export class ApprovedSourceStore {
  readonly vectorEnabled: boolean

  constructor(private readonly db: PapyrusDatabase) {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS approved_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('snapshot','live')), status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_assignments (
        source_id TEXT NOT NULL REFERENCES approved_sources(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
        PRIMARY KEY(source_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS source_documents (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES approved_sources(id) ON DELETE CASCADE,
        uri TEXT NOT NULL, title TEXT NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL,
        content TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_id,uri)
      );
      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES approved_sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, content TEXT NOT NULL, location TEXT, sha256 TEXT NOT NULL,
        UNIQUE(document_id,ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
        content, chunk_id UNINDEXED, source_id UNINDEXED, tokenize='unicode61'
      );
      CREATE INDEX IF NOT EXISTS source_assignments_user ON source_assignments(user_id,source_id);
      CREATE INDEX IF NOT EXISTS source_chunks_source ON source_chunks(source_id,id);
    `)
    this.vectorEnabled = this.enableVectorExtension()
  }

  private enableVectorExtension(): boolean {
    const extension = process.env.PAPYRUS_SQLITE_VEC_EXTENSION
    const expected = process.env.PAPYRUS_SQLITE_VEC_SHA256?.toLowerCase()
    if (!extension || !expected || !existsSync(extension)) return false
    const actual = createHash('sha256').update(readFileSync(extension)).digest('hex')
    if (actual !== expected) throw new Error('sqlite-vec extension checksum mismatch')
    try {
      this.db.sqlite.enableLoadExtension(true)
      this.db.sqlite.loadExtension(extension)
      this.db.sqlite.enableLoadExtension(false)
      return true
    } catch (error) {
      this.db.sqlite.enableLoadExtension(false)
      throw error
    }
  }

  create(name: string, kind: ApprovedSourceKind, locator: string, mode: 'snapshot' | 'live'): ApprovedSource {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db.sqlite.prepare('INSERT INTO approved_sources VALUES(?,?,?,?,?,?,?,?)').run(id,name,kind,locator,mode,'ready',now,now)
    return this.get(id)!
  }

  get(id: string): ApprovedSource | undefined {
    const row = this.db.sqlite.prepare(`SELECT s.*,
      (SELECT count(*) FROM source_documents d WHERE d.source_id=s.id) document_count
      FROM approved_sources s WHERE s.id=?`).get(id) as Row | undefined
    return row ? this.map(row) : undefined
  }

  listForUser(userId: string): ApprovedSource[] {
    return (this.db.sqlite.prepare(`SELECT s.*,
      (SELECT count(*) FROM source_documents d WHERE d.source_id=s.id) document_count
      FROM approved_sources s JOIN source_assignments a ON a.source_id=s.id
      WHERE a.user_id=? ORDER BY s.name`).all(userId) as Row[]).map((row) => this.map(row))
  }

  listAll(): ApprovedSource[] {
    return (this.db.sqlite.prepare(`SELECT s.*,
      (SELECT count(*) FROM source_documents d WHERE d.source_id=s.id) document_count
      FROM approved_sources s ORDER BY s.name`).all() as Row[]).map((row) => this.map(row))
  }

  assign(sourceId: string, userId: string): void {
    if (!this.get(sourceId) || !this.db.getPrincipal(userId)) throw new Error('Source or identity not found')
    this.db.sqlite.prepare('INSERT OR IGNORE INTO source_assignments VALUES(?,?,?)').run(sourceId,userId,new Date().toISOString())
  }

  unassign(sourceId: string, userId: string): void {
    this.db.sqlite.prepare('DELETE FROM source_assignments WHERE source_id=? AND user_id=?').run(sourceId,userId)
  }

  isAssigned(sourceId: string, userId: string): boolean {
    return Boolean(this.db.sqlite.prepare('SELECT 1 FROM source_assignments WHERE source_id=? AND user_id=?').get(sourceId,userId))
  }

  ingest(sourceId: string, uri: string, title: string, mediaType: string, content: string): void {
    if (!this.get(sourceId)) throw new Error('Source not found')
    const documentId = createHash('sha256').update(sourceId+'\0'+uri).digest('hex')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.sqlite.prepare(`INSERT INTO source_documents VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id,uri) DO UPDATE SET title=excluded.title,sha256=excluded.sha256,
        media_type=excluded.media_type,content=excluded.content,updated_at=excluded.updated_at`)
        .run(documentId,sourceId,uri,title,sha256,mediaType,content,now)
      const old = this.db.sqlite.prepare('SELECT id FROM source_chunks WHERE document_id=?').all(documentId) as Row[]
      for (const row of old) this.db.sqlite.prepare('DELETE FROM source_chunks_fts WHERE chunk_id=?').run(row.id)
      this.db.sqlite.prepare('DELETE FROM source_chunks WHERE document_id=?').run(documentId)
      for (const [ordinal, chunk] of chunkText(content).entries()) {
        const id = createHash('sha256').update(documentId+'\0'+ordinal+'\0'+chunk).digest('hex')
        const hash = createHash('sha256').update(chunk).digest('hex')
        const location = 'chunk '+(ordinal+1)
        this.db.sqlite.prepare('INSERT INTO source_chunks VALUES(?,?,?,?,?,?,?)').run(id,documentId,sourceId,ordinal,chunk,location,hash)
        this.db.sqlite.prepare('INSERT INTO source_chunks_fts(content,chunk_id,source_id) VALUES(?,?,?)').run(chunk,id,sourceId)
      }
      this.db.sqlite.prepare("UPDATE approved_sources SET status='ready',updated_at=? WHERE id=?").run(now,sourceId)
    })
  }

  refreshDirectory(sourceId: string): number {
    const source = this.get(sourceId)
    if (!source || source.kind !== 'directory') throw new Error('Directory source not found')
    const configured = resolve(source.locator)
    const root = realpathSync(configured)
    if (!lstatSync(root).isDirectory()) throw new Error('Source locator is not a directory')
    let count = 0
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory,{withFileTypes:true})) {
        const path = join(directory,entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { visit(path); continue }
        if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        const canonical = realpathSync(path)
        if (!(canonical === root || canonical.startsWith(root+sep))) continue
        const body = readFileSync(canonical)
        if (body.length > 10*1024*1024 || body.includes(0)) continue
        const rel = relative(root,canonical).split(sep).join('/')
        this.ingest(sourceId,'file:///'+rel,rel,'text/plain',body.toString('utf8'))
        count++
      }
    }
    visit(root)
    return count
  }

  search(userId: string, query: string, limit = 10): SourceSearchResult[] {
    const expression = query.trim().split(/\s+/).filter(Boolean).map((token) => '"'+token.replace(/"/g,'""')+'"').join(' AND ')
    if (!expression) return []
    const rows = this.db.sqlite.prepare(`SELECT c.id chunk_id,c.content,c.location,c.sha256,
      s.id source_id,s.name source_name,d.uri,d.title,bm25(source_chunks_fts) rank
      FROM source_chunks_fts
      JOIN source_chunks c ON c.id=source_chunks_fts.chunk_id
      JOIN source_documents d ON d.id=c.document_id
      JOIN approved_sources s ON s.id=c.source_id
      JOIN source_assignments a ON a.source_id=s.id AND a.user_id=?
      WHERE source_chunks_fts MATCH ? ORDER BY rank LIMIT ?`).all(userId,expression,Math.min(Math.max(limit,1),50)) as Row[]
    return rows.map((row) => ({
      chunkId:String(row.chunk_id),content:String(row.content),score:1/(1+Math.abs(Number(row.rank))),
      citation:{sourceId:String(row.source_id),sourceName:String(row.source_name),uri:String(row.uri),title:String(row.title),
        location:row.location?String(row.location):undefined,sha256:String(row.sha256)}
    }))
  }

  read(userId: string, chunkId: string): SourceSearchResult | undefined {
    const row = this.db.sqlite.prepare(`SELECT c.id chunk_id,c.content,c.location,c.sha256,
      s.id source_id,s.name source_name,d.uri,d.title
      FROM source_chunks c JOIN source_documents d ON d.id=c.document_id
      JOIN approved_sources s ON s.id=c.source_id
      JOIN source_assignments a ON a.source_id=s.id AND a.user_id=?
      WHERE c.id=?`).get(userId,chunkId) as Row | undefined
    return row ? {chunkId:String(row.chunk_id),content:String(row.content),score:1,
      citation:{sourceId:String(row.source_id),sourceName:String(row.source_name),uri:String(row.uri),title:String(row.title),
        location:row.location?String(row.location):undefined,sha256:String(row.sha256)}} : undefined
  }

  private map(row: Row): ApprovedSource {
    const id=String(row.id)
    const assigned=(this.db.sqlite.prepare('SELECT user_id FROM source_assignments WHERE source_id=? ORDER BY user_id').all(id) as Row[]).map((item)=>String(item.user_id))
    return {id,name:String(row.name),kind:String(row.kind) as ApprovedSourceKind,locator:String(row.locator),
      mode:String(row.mode) as 'snapshot'|'live',status:String(row.status) as ApprovedSource['status'],
      assignedUserIds:assigned,documentCount:Number(row.document_count),createdAt:String(row.created_at),updatedAt:String(row.updated_at)}
  }
}

function chunkText(content: string): string[] {
  const normalized=content.replace(/\r\n/g,'\n').trim()
  if (!normalized) return []
  const paragraphs=normalized.split(/\n{2,}/)
  const chunks:string[]=[]; let current=''
  for (const paragraph of paragraphs) {
    if (current && current.length+paragraph.length+2>1800) { chunks.push(current); current='' }
    current+=(current?'\n\n':'')+paragraph
    while (current.length>2400) { chunks.push(current.slice(0,1800)); current=current.slice(1600) }
  }
  if (current) chunks.push(current)
  return chunks
}
