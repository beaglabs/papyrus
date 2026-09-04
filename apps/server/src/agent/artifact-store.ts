import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { createDocx } from './artifact-docx.js'
import { createPdf } from './artifact-pdf.js'
import { createXlsx } from './artifact-xlsx.js'

export type ArtifactFormat = 'pdf' | 'docx' | 'xlsx' | 'txt' | 'md' | 'json' | 'csv' | 'html'

export interface ArtifactSheetInput {
  name?: string
  rows: Array<Array<string | number | boolean | null>>
}

export interface CreateArtifactInput {
  format: ArtifactFormat
  name: string
  title?: string
  content?: string
  sheets?: ArtifactSheetInput[]
  skill?: string
  skillVersion?: string
  sessionId?: string
}

export interface ArtifactPreview {
  kind: 'pdf' | 'document' | 'spreadsheet' | 'video' | 'image' | 'text' | 'generic'
  text?: string
  sheets?: Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }>
}

export interface ArtifactRecord {
  kind: 'artifact'
  id: string
  name: string
  mediaType: string
  size: number
  sha256: string
  createdAt: string
  contentUrl: string
  downloadUrl: string
  preview: ArtifactPreview
  provenance: {
    producer: 'papyrus-artifact-runtime' | 'workspace'
    skill?: string
    skillVersion?: string
    sessionId?: string
  }
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const FORMAT_EXT: Record<ArtifactFormat, string> = {
  pdf: '.pdf', docx: '.docx', xlsx: '.xlsx', txt: '.txt', md: '.md', json: '.json', csv: '.csv', html: '.html',
}

export class ArtifactStore {
  readonly root: string

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'artifacts')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  create(input: CreateArtifactInput): ArtifactRecord {
    const extension = FORMAT_EXT[input.format]
    if (!extension) throw new Error('Unsupported artifact format')
    const name = normalizedGeneratedName(input.name, extension)
    const content = (input.content ?? '').slice(0, 1_000_000)
    const bytes = this.generate(input.format, content, input.title ?? basename(name, extname(name)), input.sheets)
    return this.persist(name, bytes, {
      producer: 'papyrus-artifact-runtime',
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.skillVersion ? { skillVersion: input.skillVersion } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }, previewForGenerated(input.format, content, input.sheets))
  }

  importBytes(name: string, bytes: Buffer, options: { skill?: string; skillVersion?: string; sessionId?: string } = {}): ArtifactRecord {
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('Artifact exceeds the 100 MiB publication limit')
    const safe = normalizedImportedName(name, name)
    return this.persist(safe, bytes, {
      producer: 'workspace',
      ...(options.skill ? { skill: options.skill } : {}),
      ...(options.skillVersion ? { skillVersion: options.skillVersion } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    }, previewForPath(safe, bytes))
  }

  importWorkspaceFile(path: string, workspaceRoot: string, options: { name?: string; skill?: string; skillVersion?: string; sessionId?: string } = {}): ArtifactRecord {
    const root = realpathSync(workspaceRoot)
    const target = realpathSync(resolve(root, path))
    if (target !== root && !target.startsWith(root + sep)) throw new Error('Artifact path must remain inside the sandbox workspace')
    const stats = statSync(target)
    if (!stats.isFile()) throw new Error('Artifact path must identify a regular file')
    if (stats.size > 100 * 1024 * 1024) throw new Error('Artifact exceeds the 100 MiB workspace publication limit')
    const name = normalizedImportedName(options.name, basename(target))
    const bytes = readFileSync(target)
    return this.persist(name, bytes, {
      producer: 'workspace',
      ...(options.skill ? { skill: options.skill } : {}),
      ...(options.skillVersion ? { skillVersion: options.skillVersion } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    }, previewForPath(target, bytes))
  }

  list(): ArtifactRecord[] {
    const indexPath = join(this.root, 'index.json')
    if (!existsSync(indexPath)) return []
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as ArtifactRecord[]
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }

  get(id: string): ArtifactRecord | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
    const recordPath = join(this.root, id, 'record.json')
    if (existsSync(recordPath)) {
      try {
        const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as ArtifactRecord
        if (parsed?.id === id && parsed.kind === 'artifact') return parsed
      } catch { /* fall through to the bounded index */ }
    }
    return this.list().find((artifact) => artifact.id === id)
  }

  contentPath(id: string): string {
    const record = this.get(id)
    if (!record) throw new Error('Artifact not found')
    const path = join(this.root, id, record.name)
    if (!existsSync(path)) throw new Error('Artifact content is unavailable')
    return path
  }

  private persist(name: string, bytes: Buffer, provenance: ArtifactRecord['provenance'], preview: ArtifactPreview): ArtifactRecord {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const directory = join(this.root, id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, name)
    writeFileSync(path, bytes, { mode: 0o600 })
    const record: ArtifactRecord = {
      kind: 'artifact',
      id,
      name,
      mediaType: mediaType(name),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt,
      contentUrl: `/api/artifacts/${encodeURIComponent(id)}/content`,
      downloadUrl: `/api/artifacts/${encodeURIComponent(id)}/content?download=1`,
      preview,
      provenance,
    }
    writeFileSync(join(directory, 'record.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
    const current = this.list()
    current.unshift(record)
    writeFileSync(join(this.root, 'index.json'), JSON.stringify(current.slice(0, 1000), null, 2), { mode: 0o600 })
    return record
  }

  private generate(format: ArtifactFormat, content: string, title: string, sheets?: ArtifactSheetInput[]): Buffer {
    switch (format) {
      case 'pdf': return createPdf(title, content)
      case 'docx': return createDocx(title, content)
      case 'xlsx': return createXlsx(sheets?.length ? sheets : [{ name: 'Sheet1', rows: tabularContent(content) }])
      case 'json': {
        try { return Buffer.from(JSON.stringify(JSON.parse(content), null, 2) + '\n') } catch { return Buffer.from(content) }
      }
      default: return Buffer.from(content)
    }
  }
}

function normalizedGeneratedName(value: string, extension: string): string {
  const raw = basename(value.trim() || `artifact${extension}`).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 180)
  const current = extname(raw)
  const stem = current ? basename(raw, current) : raw
  return `${stem || 'artifact'}${extension}`
}

function normalizedImportedName(requested: string | undefined, sourceName: string): string {
  const sourceExtension = extname(sourceName).toLowerCase() || '.bin'
  const raw = basename((requested ?? sourceName).trim() || sourceName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 180)
  const current = extname(raw)
  const stem = current ? basename(raw, current) : raw
  return `${stem || 'artifact'}${sourceExtension}`
}

function mediaType(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

function previewForGenerated(format: ArtifactFormat, content: string, sheets?: ArtifactSheetInput[]): ArtifactPreview {
  if (format === 'pdf') return { kind: 'pdf', text: content.slice(0, 1200) }
  if (format === 'docx') return { kind: 'document', text: content.slice(0, 2400) }
  if (format === 'xlsx') return {
    kind: 'spreadsheet',
    sheets: (sheets?.length ? sheets : [{ name: 'Sheet1', rows: tabularContent(content) }]).slice(0, 8).map((sheet, index) => ({
      name: safeSheetName(sheet.name ?? `Sheet${index + 1}`),
      rows: sheet.rows.slice(0, 20).map((row) => row.slice(0, 12).map(previewCell)),
    })),
  }
  return { kind: 'text', text: content.slice(0, 2400) }
}

function previewForPath(path: string, bytes: Buffer): ArtifactPreview {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return { kind: 'pdf' }
  if (ext === '.docx') return { kind: 'document' }
  if (ext === '.xlsx' || ext === '.csv') return { kind: 'spreadsheet' }
  if (ext === '.mp4' || ext === '.webm') return { kind: 'video' }
  if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) return { kind: 'image' }
  if (ext === '.svg') return { kind: 'generic' }
  if (['.txt', '.md', '.json', '.html'].includes(ext)) return { kind: 'text', text: bytes.toString('utf8', 0, Math.min(bytes.length, 2400)) }
  return { kind: 'generic' }
}

function tabularContent(content: string): Array<Array<string | number | boolean | null>> {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0).slice(0, 10_000)
  if (!lines.length) return [['']]
  const delimiter = lines.some((line) => line.includes('\t')) ? '\t' : ','
  return lines.map((line) => line.split(delimiter).slice(0, 100))
}

function safeSheetName(value: string): string {
  return value.replace(/[\\/*?:\[\]]/g, '-').slice(0, 31) || 'Sheet'
}

function previewCell(value: string | number | boolean | null): string | number | boolean | null {
  return typeof value === 'string' && value.length > 160 ? value.slice(0, 157) + '…' : value
}
