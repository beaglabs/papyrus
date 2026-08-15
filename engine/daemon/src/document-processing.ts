import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { getDb } from './database.js'

export type DocumentJobState = 'queued' | 'processing' | 'needs-input' | 'complete' | 'failed'

export interface DocumentProcessingSettings {
  maxFileSizeBytes: number
  ocrEnabled: boolean
  ocrLanguages: string[]
  nativeTextMinimum: number
  jobTimeoutSeconds: number
  retainIntermediates: boolean
  updatedBy: string
  updatedAt: string
}

export interface DocumentProcessingJob {
  id: string
  intakeItemId: string
  state: DocumentJobState
  extractionMethod?: string
  engineName?: string
  engineVersion?: string
  attempts: number
  maxAttempts: number
  errorCode?: string
  errorMessage?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  updatedAt: string
}

const DEFAULT_SETTINGS = {
  maxFileSizeBytes: 25 * 1024 * 1024,
  ocrEnabled: true,
  ocrLanguages: ['eng'],
  nativeTextMinimum: 32,
  jobTimeoutSeconds: 120,
  retainIntermediates: true,
}

function mapJob(row: Record<string, unknown>): DocumentProcessingJob {
  return {
    id: String(row.id),
    intakeItemId: String(row.intake_item_id),
    state: row.state as DocumentJobState,
    extractionMethod: row.extraction_method ? String(row.extraction_method) : undefined,
    engineName: row.engine_name ? String(row.engine_name) : undefined,
    engineVersion: row.engine_version ? String(row.engine_version) : undefined,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    updatedAt: String(row.updated_at),
  }
}

export function getDocumentProcessingSettings(organizationId: string): DocumentProcessingSettings {
  const row = getDb()
    .prepare('SELECT * FROM document_processing_settings WHERE organization_id = ?')
    .get(organizationId) as Record<string, unknown> | undefined
  if (!row) return { ...DEFAULT_SETTINGS, updatedBy: 'system', updatedAt: '' }
  return {
    maxFileSizeBytes: Number(row.max_file_size_bytes),
    ocrEnabled: Boolean(row.ocr_enabled),
    ocrLanguages: JSON.parse(String(row.ocr_languages)),
    nativeTextMinimum: Number(row.native_text_minimum),
    jobTimeoutSeconds: Number(row.job_timeout_seconds),
    retainIntermediates: Boolean(row.retain_intermediates),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  }
}

export function updateDocumentProcessingSettings(
  organizationId: string,
  input: Partial<Omit<DocumentProcessingSettings, 'updatedBy' | 'updatedAt'>>,
  updatedBy: string,
): DocumentProcessingSettings {
  const current = getDocumentProcessingSettings(organizationId)
  const next = {
    maxFileSizeBytes: Math.min(
      250 * 1024 * 1024,
      Math.max(1024, Math.trunc(input.maxFileSizeBytes ?? current.maxFileSizeBytes)),
    ),
    ocrEnabled: input.ocrEnabled ?? current.ocrEnabled,
    ocrLanguages: (input.ocrLanguages ?? current.ocrLanguages)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 12),
    nativeTextMinimum: Math.min(
      10000,
      Math.max(1, Math.trunc(input.nativeTextMinimum ?? current.nativeTextMinimum)),
    ),
    jobTimeoutSeconds: Math.min(
      1800,
      Math.max(10, Math.trunc(input.jobTimeoutSeconds ?? current.jobTimeoutSeconds)),
    ),
    retainIntermediates: input.retainIntermediates ?? current.retainIntermediates,
  }
  if (next.ocrLanguages.length === 0) throw new Error('At least one OCR language is required')
  const now = new Date().toISOString()
  getDb()
    .prepare(`INSERT INTO document_processing_settings
    (organization_id, max_file_size_bytes, ocr_enabled, ocr_languages, native_text_minimum, job_timeout_seconds, retain_intermediates, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id) DO UPDATE SET
      max_file_size_bytes=excluded.max_file_size_bytes, ocr_enabled=excluded.ocr_enabled,
      ocr_languages=excluded.ocr_languages, native_text_minimum=excluded.native_text_minimum,
      job_timeout_seconds=excluded.job_timeout_seconds, retain_intermediates=excluded.retain_intermediates,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(
      organizationId,
      next.maxFileSizeBytes,
      Number(next.ocrEnabled),
      JSON.stringify(next.ocrLanguages),
      next.nativeTextMinimum,
      next.jobTimeoutSeconds,
      Number(next.retainIntermediates),
      updatedBy,
      now,
    )
  return { ...next, updatedBy, updatedAt: now }
}

export function enqueueDocumentProcessing(
  organizationId: string,
  intakeItemId: string,
): DocumentProcessingJob {
  const id = `docjob-${randomUUID()}`
  const now = new Date().toISOString()
  getDb()
    .prepare(`INSERT INTO document_processing_jobs
    (id, organization_id, intake_item_id, state, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', ?, ?)`)
    .run(id, organizationId, intakeItemId, now, now)
  return mapJob(
    getDb().prepare('SELECT * FROM document_processing_jobs WHERE id = ?').get(id) as Record<
      string,
      unknown
    >,
  )
}

export function getDocumentJob(intakeItemId: string): DocumentProcessingJob | null {
  const row = getDb()
    .prepare('SELECT * FROM document_processing_jobs WHERE intake_item_id = ?')
    .get(intakeItemId) as Record<string, unknown> | undefined
  return row ? mapJob(row) : null
}

function printableText(bytes: Buffer): string {
  return bytes
    .toString('utf8')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && character !== '\n' && character !== '\r' && character !== '\t'
        ? ' '
        : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function deriveText(
  mediaType: string,
  filename: string,
  bytes: Buffer,
  minimum: number,
  ocrEnabled: boolean,
  ocrLanguages: string[],
): { state: DocumentJobState; method?: string; text?: string; code?: string; message?: string } {
  const lower = filename.toLowerCase()
  if (/(zip|gzip|rar|7z)/i.test(mediaType) || /\.(zip|gz|rar|7z)$/i.test(lower))
    return {
      state: 'needs-input',
      code: 'ARCHIVE_INSPECTION_REQUIRED',
      message: 'Archive processing is reserved for the hardened intake phase.',
    }
  const image = /^image\//.test(mediaType) || /\.(png|jpe?g|tiff?|bmp)$/i.test(lower)
  const pdf = mediaType === 'application/pdf' || lower.endsWith('.pdf')
  if (image || pdf) {
    const directory = mkdtempSync(join(tmpdir(), 'papyrus-ocr-'))
    const target = join(directory, `source${extname(filename) || (pdf ? '.pdf' : '.img')}`)
    writeFileSync(target, bytes, { mode: 0o600 })
    try {
      if (pdf) {
        try {
          const native = execFileSync('pdftotext', [target, '-'], {
            encoding: 'utf8',
            timeout: 120_000,
          }).trim()
          if (native.length >= minimum)
            return { state: 'complete', method: 'pdf-native-text', text: native }
        } catch {
          /* continue to OCR when enabled */
        }
        if (!ocrEnabled)
          return {
            state: 'needs-input',
            code: 'OCR_DISABLED',
            message: 'The PDF has insufficient native text and OCR is disabled.',
          }
        try {
          const prefix = join(directory, 'page')
          execFileSync('pdftoppm', ['-png', '-r', '200', target, prefix], { timeout: 120_000 })
          const pages = readdirSync(directory)
            .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
            .sort()
          const text = pages
            .map((page) =>
              execFileSync(
                'tesseract',
                [join(directory, page), 'stdout', '-l', ocrLanguages.join('+')],
                { encoding: 'utf8', timeout: 120_000 },
              ),
            )
            .join('\n')
            .trim()
          if (text.length >= minimum) return { state: 'complete', method: 'pdf-ocr', text }
        } catch {
          return {
            state: 'needs-input',
            code: 'OCR_ENGINE_REQUIRED',
            message: 'PDF OCR requires pdftoppm and Tesseract with the configured language packs.',
          }
        }
      } else {
        if (!ocrEnabled)
          return {
            state: 'needs-input',
            code: 'OCR_DISABLED',
            message: 'OCR is disabled for image documents.',
          }
        try {
          const text = execFileSync('tesseract', [target, 'stdout', '-l', ocrLanguages.join('+')], {
            encoding: 'utf8',
            timeout: 120_000,
          }).trim()
          if (text.length >= minimum) return { state: 'complete', method: 'image-ocr', text }
        } catch {
          return {
            state: 'needs-input',
            code: 'OCR_ENGINE_REQUIRED',
            message: 'Image OCR requires Tesseract with the configured language packs.',
          }
        }
      }
      return {
        state: 'needs-input',
        code: 'OCR_EMPTY',
        message: 'OCR completed but did not produce enough text for release.',
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const text = printableText(bytes)
  if (text.length < minimum)
    return {
      state: 'needs-input',
      code: 'OCR_ENGINE_REQUIRED',
      message: 'Native extraction produced insufficient text; OCR is required.',
    }
  return { state: 'complete', method: 'native-text', text }
}

export function processDocumentJob(
  intakeItemId: string,
  organizationId?: string,
): DocumentProcessingJob {
  const db = getDb()
  const organizationFilter = organizationId ? ' AND i.organization_id = ?' : ''
  const row = db
    .prepare(`SELECT j.*, i.organization_id, i.filename, i.media_type, i.content_base64, i.size_bytes
    FROM document_processing_jobs j JOIN intake_items i ON i.id = j.intake_item_id
    WHERE j.intake_item_id = ?${organizationFilter}`)
    .get(...(organizationId ? [intakeItemId, organizationId] : [intakeItemId])) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error('Document processing job not found')
  if (row.state === 'complete') return mapJob(row)
  const settings = getDocumentProcessingSettings(String(row.organization_id))
  const now = new Date().toISOString()
  db.prepare(`UPDATE document_processing_jobs SET state='processing', attempts=attempts+1,
    started_at=COALESCE(started_at, ?), updated_at=?, error_code=NULL, error_message=NULL WHERE intake_item_id=?`).run(
    now,
    now,
    intakeItemId,
  )
  try {
    if (Number(row.size_bytes) > settings.maxFileSizeBytes) throw new Error('FILE_TOO_LARGE')
    const bytes = Buffer.from(String(row.content_base64), 'base64')
    const result = deriveText(
      String(row.media_type),
      String(row.filename),
      bytes,
      settings.nativeTextMinimum,
      settings.ocrEnabled,
      settings.ocrLanguages,
    )
    if (result.state === 'needs-input') {
      db.prepare(`UPDATE document_processing_jobs SET state='needs-input', engine_name='papyrus-native', engine_version='0.1.0',
        error_code=?, error_message=?, updated_at=? WHERE intake_item_id=?`).run(
        result.code,
        result.message,
        now,
        intakeItemId,
      )
    } else {
      const content = Buffer.from(result.text ?? '', 'utf8')
      const jobId = String(row.id)
      db.prepare(`INSERT OR REPLACE INTO document_derivatives
        (id, organization_id, intake_item_id, job_id, kind, media_type, sha256, content_base64, page_count, created_at)
        VALUES (?, ?, ?, ?, 'text', 'text/plain; charset=utf-8', ?, ?, NULL, ?)`).run(
        `derivative-${randomUUID()}`,
        row.organization_id,
        intakeItemId,
        jobId,
        createHash('sha256').update(content).digest('hex'),
        content.toString('base64'),
        now,
      )
      db.prepare(`UPDATE document_processing_jobs SET state='complete', extraction_method=?, engine_name='papyrus-native',
        engine_version='0.1.0', completed_at=?, updated_at=? WHERE intake_item_id=?`).run(
        result.method,
        now,
        now,
        intakeItemId,
      )
    }
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'FILE_TOO_LARGE'
        ? 'FILE_TOO_LARGE'
        : 'PROCESSING_FAILED'
    const message =
      code === 'FILE_TOO_LARGE'
        ? 'File exceeds the organization processing limit.'
        : error instanceof Error
          ? error.message
          : 'Document processing failed'
    db.prepare(
      `UPDATE document_processing_jobs SET state='failed', error_code=?, error_message=?, completed_at=?, updated_at=? WHERE intake_item_id=?`,
    ).run(code, message, now, now, intakeItemId)
  }
  return getDocumentJob(intakeItemId) as DocumentProcessingJob
}
