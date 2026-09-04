import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { AgentLink, IntegrationConfiguration, LinkInbound, LinkType } from '@papyrus/contracts'
import { LINK_TYPES } from '@papyrus/contracts'
import { LINK_PUBLISHER_CATALOG_ID, catalogEntry } from './catalog.js'
import { canonical, type AgentDatabase } from './database.js'
import type { PapyrusAgentFSFilesystem } from './mastra/workspace-agentfs.js'

type Row = Record<string, unknown>

export const LINK_EXECUTOR_INTEGRATION_ID = 'papyrus-links-system'

export interface LinkDraftAsset {
  name: string
  path: string
  sha256: string
  mediaType: string
}

export interface LinkDraftAssetInput {
  sourcePath: string
  sourceReferences: string[]
  publicName?: string
}

export interface LinkDraftManifest {
  formatVersion: 1
  draftId: string
  name: string
  slug: string
  type: LinkType
  sourcePath: string
  sourceSha256: string
  mediaType: string
  createdAt: string
  workflowId?: string
  scheduleId?: string
  threadId?: string
  resourceId?: string
  logo?: LinkDraftAsset
  logoText?: string
  assets?: LinkDraftAsset[]
}

export interface PrepareLinkInput {
  name: string
  type: LinkType
  sourcePath: string
  slug?: string
  workflowId?: string
  scheduleId?: string
  threadId?: string
  resourceId?: string
  logoPath?: string
  logoText?: string
  assets?: LinkDraftAssetInput[]
}

export class LinkStore {
  constructor(
    readonly db: AgentDatabase,
    readonly filesystem: PapyrusAgentFSFilesystem,
  ) {
    this.migrate()
  }

  ensureExecutorIntegration(): IntegrationConfiguration {
    const existing = this.db.getIntegration(LINK_EXECUTOR_INTEGRATION_ID)
    if (existing) {
      if (existing.state !== 'active' || existing.health !== 'healthy') {
        const now = new Date().toISOString()
        this.db.sqlite.prepare(`UPDATE agent_integrations SET state='active',health='healthy',deleted_at=NULL,updated_at=?,version=version+1 WHERE id=?`)
          .run(now, LINK_EXECUTOR_INTEGRATION_ID)
      }
      return this.db.getIntegration(LINK_EXECUTOR_INTEGRATION_ID) as IntegrationConfiguration
    }

    const entry = catalogEntry(LINK_PUBLISHER_CATALOG_ID)
    if (!entry) throw new Error('Papyrus Links executor catalog entry is missing')
    const now = new Date().toISOString()
    this.db.sqlite.prepare(`INSERT INTO agent_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,
      health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      LINK_EXECUTOR_INTEGRATION_ID,
      entry.id,
      entry.name,
      entry.integrationClass,
      entry.authority,
      entry.risk,
      'active',
      null,
      'workspace:/Library/Links',
      null,
      '{}',
      'healthy',
      'system:papyrus',
      now,
      now,
    )
    return this.db.getIntegration(LINK_EXECUTOR_INTEGRATION_ID) as IntegrationConfiguration
  }

  list(): AgentLink[] {
    return (this.db.sqlite.prepare('SELECT * FROM agent_links WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as Row[])
      .map((row) => this.link(row))
  }

  get(id: string): AgentLink | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_links WHERE id=? AND deleted_at IS NULL').get(id) as Row | undefined
    return row ? this.link(row) : undefined
  }

  getBySlug(slug: string): AgentLink | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_links WHERE slug=? AND deleted_at IS NULL').get(normalizeSlug(slug)) as Row | undefined
    return row ? this.link(row) : undefined
  }

  async prepareDraft(input: PrepareLinkInput): Promise<LinkDraftManifest> {
    if (!LINK_TYPES.includes(input.type)) throw new Error('Link type must be webpage, api, or webhook')
    const name = cleanName(input.name)
    const slug = normalizeSlug(input.slug || name)
    const source = normalizeLibrarySource(input.sourcePath)
    const described = await this.filesystem.describeLibraryFile(source)
    validateSource(input.type, described.mediaType)

    const draftId = randomUUID()
    const draftRoot = `/Library/Links/Drafts/${draftId}`
    const snapshotPath = `${draftRoot}/${posix.basename(source)}`
    const assets: LinkDraftAsset[] = []

    if (input.type === 'webpage' && input.assets?.length) {
      let html = String(await this.filesystem.readFile(source, { encoding: 'utf8' }))
      const usedNames = new Set<string>()
      for (let index = 0; index < input.assets.length; index++) {
        const assetInput = input.assets[index] as LinkDraftAssetInput
        const assetSource = normalizeLibrarySource(assetInput.sourcePath)
        const describedAsset = await this.filesystem.describeLibraryFile(assetSource)
        let assetName = safeAssetName(assetInput.publicName ?? describedAsset.name)
        if (usedNames.has(assetName)) assetName = `${index + 1}-${assetName}`
        usedNames.add(assetName)

        const draftAssetPath = `${draftRoot}/assets/${assetName}`
        await this.filesystem.copyFile(assetSource, draftAssetPath, { overwrite: false })
        const draftAsset = await this.filesystem.describeLibraryFile(draftAssetPath)
        const publicReference = `/l/${slug}/assets/${encodeURIComponent(assetName)}`
        for (const reference of assetInput.sourceReferences) {
          if (reference) html = html.split(reference).join(publicReference)
        }
        assets.push({
          name: assetName,
          path: draftAsset.path,
          sha256: draftAsset.sha256,
          mediaType: draftAsset.mediaType,
        })
      }
      await this.filesystem.writeFile(snapshotPath, html, { overwrite: false, recursive: true })
    } else {
      await this.filesystem.copyFile(source, snapshotPath, { overwrite: false })
    }

    const snapshot = await this.filesystem.describeLibraryFile(snapshotPath)
    validateSource(input.type, snapshot.mediaType)

    const workflowId = cleanOptional(input.workflowId)
    const scheduleId = cleanOptional(input.scheduleId)
    const threadId = cleanOptional(input.threadId)
    const resourceId = cleanOptional(input.resourceId)
    if (input.type === 'webhook' && (!threadId || !resourceId)) {
      throw new Error('Webhook Links must be scoped to the Agent session that created them')
    }

    const logoText = cleanLogoText(input.logoText)
    let logo: LinkDraftAsset | undefined
    if (input.logoPath?.trim()) {
      const logoSource = normalizeLibrarySource(input.logoPath)
      const describedLogo = await this.filesystem.describeLibraryFile(logoSource)
      if (!normalizedMediaType(describedLogo.mediaType).startsWith('image/')) throw new Error('Webhook Link logo must be an image file')
      const logoName = safeAssetName(describedLogo.name)
      const draftLogoPath = `${draftRoot}/logo/${logoName}`
      await this.filesystem.copyFile(logoSource, draftLogoPath, { overwrite: false })
      const draftLogo = await this.filesystem.describeLibraryFile(draftLogoPath)
      logo = { name: logoName, path: draftLogo.path, sha256: draftLogo.sha256, mediaType: draftLogo.mediaType }
    }

    const manifest: LinkDraftManifest = {
      formatVersion: 1,
      draftId,
      name,
      slug,
      type: input.type,
      sourcePath: snapshot.path,
      sourceSha256: snapshot.sha256,
      mediaType: snapshot.mediaType,
      createdAt: new Date().toISOString(),
      ...(workflowId ? { workflowId } : {}),
      ...(scheduleId ? { scheduleId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(logo ? { logo } : {}),
      ...(logoText ? { logoText } : {}),
      ...(assets.length ? { assets } : {}),
    }
    await this.filesystem.writeFile(`${draftRoot}/link.json`, JSON.stringify(manifest, null, 2) + '\n', { overwrite: false, recursive: true })
    return manifest
  }

  async readManifest(path: string): Promise<LinkDraftManifest> {
    const normalized = normalizeDraftManifestPath(path)
    const raw = await this.filesystem.readFile(normalized, { encoding: 'utf8' })
    let parsed: unknown
    try { parsed = JSON.parse(String(raw)) } catch { throw new Error('Link draft manifest is not valid JSON') }
    return validateManifest(parsed)
  }

  async publishFromManifest(manifestPath: string, actorOid: string): Promise<AgentLink> {
    const manifest = await this.readManifest(manifestPath)
    const existing = this.get(manifest.draftId)
    if (existing) return existing

    const collision = this.getBySlug(manifest.slug)
    if (collision && collision.id !== manifest.draftId) throw new Error(`Link slug ${manifest.slug} is already live`)

    const current = await this.filesystem.describeLibraryFile(manifest.sourcePath)
    if (current.sha256 !== manifest.sourceSha256) throw new Error('Link source changed after the operator reviewed the publication request')
    validateSource(manifest.type, current.mediaType)

    const finalRoot = `/Library/Links/Published/${manifest.draftId}`
    let finalLogoPath: string | undefined
    if (manifest.logo) {
      const currentLogo = await this.filesystem.describeLibraryFile(manifest.logo.path)
      if (currentLogo.sha256 !== manifest.logo.sha256) throw new Error('Link logo changed after the operator reviewed the publication request')
      finalLogoPath = `${finalRoot}/logo/${manifest.logo.name}`
      if (!(await this.filesystem.exists(finalLogoPath))) {
        await this.filesystem.copyFile(manifest.logo.path, finalLogoPath, { overwrite: false })
      }
      const finalLogo = await this.filesystem.describeLibraryFile(finalLogoPath)
      if (finalLogo.sha256 !== manifest.logo.sha256) throw new Error('Published Link logo does not match the approved snapshot')
    }

    for (const asset of manifest.assets ?? []) {
      const currentAsset = await this.filesystem.describeLibraryFile(asset.path)
      if (currentAsset.sha256 !== asset.sha256) throw new Error(`Link asset ${asset.name} changed after the operator reviewed the publication request`)
      const finalAssetPath = `${finalRoot}/assets/${asset.name}`
      if (!(await this.filesystem.exists(finalAssetPath))) {
        await this.filesystem.copyFile(asset.path, finalAssetPath, { overwrite: false })
      }
      const finalAsset = await this.filesystem.describeLibraryFile(finalAssetPath)
      if (finalAsset.sha256 !== asset.sha256) throw new Error(`Published Link asset ${asset.name} does not match the approved snapshot`)
    }

    const finalPath = `${finalRoot}/${posix.basename(manifest.sourcePath)}`
    if (!(await this.filesystem.exists(finalPath))) {
      await this.filesystem.copyFile(manifest.sourcePath, finalPath, { overwrite: false })
    }
    const final = await this.filesystem.describeLibraryFile(finalPath)
    if (final.sha256 !== manifest.sourceSha256) throw new Error('Published Link snapshot does not match the approved source')

    const now = new Date().toISOString()
    this.db.sqlite.prepare(`INSERT INTO agent_links(
      id,name,slug,type,state,blob_path,media_type,source_sha256,public_path,workflow_id,schedule_id,
      thread_id,resource_id,logo_path,logo_media_type,logo_text,
      created_by_oid,created_at,updated_at,ping_count,inbound_count
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`).run(
      manifest.draftId,
      manifest.name,
      manifest.slug,
      manifest.type,
      'live',
      final.path,
      final.mediaType,
      final.sha256,
      `/l/${manifest.slug}`,
      manifest.workflowId ?? null,
      manifest.scheduleId ?? null,
      manifest.threadId ?? null,
      manifest.resourceId ?? null,
      finalLogoPath ?? null,
      manifest.logo?.mediaType ?? null,
      manifest.logoText ?? null,
      actorOid,
      now,
      now,
    )
    this.appendEvent(manifest.draftId, 'LinkPublished', {
      type: manifest.type,
      slug: manifest.slug,
      blobPath: final.path,
      sourceSha256: final.sha256,
      assetCount: manifest.assets?.length ?? 0,
      threadId: manifest.threadId,
      resourceId: manifest.resourceId,
      hasLogo: Boolean(finalLogoPath || manifest.logoText),
      actorOid,
    })
    return this.get(manifest.draftId) as AgentLink
  }

  disableWebhookLinksForThread(threadId: string, actorOid: string): AgentLink[] {
    const scoped = (this.db.sqlite.prepare(
      "SELECT * FROM agent_links WHERE deleted_at IS NULL AND type='webhook' AND state='live' AND thread_id=? ORDER BY updated_at DESC"
    ).all(threadId) as Row[]).map((row) => this.link(row))
    if (!scoped.length) return []

    const now = new Date().toISOString()
    const update = this.db.sqlite.prepare("UPDATE agent_links SET state='disabled',updated_at=? WHERE id=? AND state='live'")
    for (const link of scoped) {
      update.run(now, link.id)
      this.appendEvent(link.id, 'LinkDisabled', { reason: 'session_unavailable', threadId, actorOid })
    }
    return scoped.map((link) => this.get(link.id) as AgentLink)
  }

  recordValidation(id: string, provider: 'local-static' | 'kitesurf'): AgentLink {
    this.require(id)
    const now = new Date().toISOString()
    this.db.sqlite.prepare('UPDATE agent_links SET validation_provider=?,validated_at=?,updated_at=? WHERE id=?')
      .run(provider, now, now, id)
    this.appendEvent(id, 'LinkValidated', { provider })
    return this.get(id) as AgentLink
  }

  recordPing(id: string, metadata: Record<string, unknown> = {}): AgentLink {
    const link = this.require(id)
    const now = new Date().toISOString()
    this.db.sqlite.prepare('UPDATE agent_links SET last_ping_at=?,ping_count=ping_count+1,updated_at=? WHERE id=?')
      .run(now, now, id)
    this.appendEvent(id, 'LinkPinged', metadata)
    return this.get(link.id) as AgentLink
  }

  recordInbound(input: Omit<LinkInbound, 'id'>): LinkInbound {
    this.require(input.linkId)
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO agent_link_inbounds(
      id,link_id,blob_path,method,content_type,received_at,size,sha256
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      id,
      input.linkId,
      input.blobPath,
      input.method,
      input.contentType ?? null,
      input.receivedAt,
      input.size,
      input.sha256,
    )
    const now = new Date().toISOString()
    this.db.sqlite.prepare('UPDATE agent_links SET inbound_count=inbound_count+1,last_ping_at=?,updated_at=? WHERE id=?')
      .run(input.receivedAt, now, input.linkId)
    this.appendEvent(input.linkId, 'LinkInboundReceived', {
      inboundId: id,
      blobPath: input.blobPath,
      method: input.method,
      size: input.size,
      sha256: input.sha256,
    })
    return { id, ...input }
  }

  listInbounds(linkId: string, limit = 100): LinkInbound[] {
    this.require(linkId)
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)))
    return (this.db.sqlite.prepare('SELECT * FROM agent_link_inbounds WHERE link_id=? ORDER BY received_at DESC LIMIT ?').all(linkId, bounded) as Row[])
      .map((row) => ({
        id: String(row.id),
        linkId: String(row.link_id),
        blobPath: String(row.blob_path),
        method: String(row.method),
        ...(row.content_type ? { contentType: String(row.content_type) } : {}),
        receivedAt: String(row.received_at),
        size: Number(row.size),
        sha256: String(row.sha256),
      }))
  }

  private require(id: string): AgentLink {
    const link = this.get(id)
    if (!link) throw new Error('Link not found')
    return link
  }

  private appendEvent(linkId: string, action: string, data: Record<string, unknown>): void {
    const previous = this.db.sqlite.prepare('SELECT hash FROM agent_link_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined
    const previousHash = previous ? String(previous.hash) : '0'.repeat(64)
    const occurredAt = new Date().toISOString()
    const hash = createHash('sha256').update(canonical({ linkId, action, occurredAt, data, previousHash })).digest('hex')
    this.db.sqlite.prepare('INSERT INTO agent_link_events(link_id,action,occurred_at,data_json,previous_hash,hash) VALUES(?,?,?,?,?,?)')
      .run(linkId, action, occurredAt, JSON.stringify(data), previousHash, hash)
  }

  private link(row: Row): AgentLink {
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      type: row.type as LinkType,
      state: row.state as AgentLink['state'],
      blobPath: String(row.blob_path),
      mediaType: String(row.media_type),
      sourceSha256: String(row.source_sha256),
      publicPath: String(row.public_path),
      ...(row.workflow_id ? { workflowId: String(row.workflow_id) } : {}),
      ...(row.schedule_id ? { scheduleId: String(row.schedule_id) } : {}),
      ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
      ...(row.resource_id ? { resourceId: String(row.resource_id) } : {}),
      ...(row.logo_path ? { logoPath: String(row.logo_path) } : {}),
      ...(row.logo_media_type ? { logoMediaType: String(row.logo_media_type) } : {}),
      ...(row.logo_text ? { logoText: String(row.logo_text) } : {}),
      createdByOid: String(row.created_by_oid),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.last_ping_at ? { lastPingAt: String(row.last_ping_at) } : {}),
      pingCount: Number(row.ping_count),
      inboundCount: Number(row.inbound_count),
      ...(row.validation_provider ? { validationProvider: String(row.validation_provider) as 'local-static' | 'kitesurf' } : {}),
      ...(row.validated_at ? { validatedAt: String(row.validated_at) } : {}),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_links (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('webpage','api','webhook')),
        state TEXT NOT NULL CHECK(state IN ('live','disabled','failed')),
        blob_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        public_path TEXT NOT NULL,
        workflow_id TEXT,
        schedule_id TEXT,
        thread_id TEXT,
        resource_id TEXT,
        logo_path TEXT,
        logo_media_type TEXT,
        logo_text TEXT,
        created_by_oid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_ping_at TEXT,
        ping_count INTEGER NOT NULL DEFAULT 0,
        inbound_count INTEGER NOT NULL DEFAULT 0,
        validation_provider TEXT,
        validated_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_links_type_state ON agent_links(type,state,updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_link_inbounds (
        id TEXT PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES agent_links(id),
        blob_path TEXT NOT NULL,
        method TEXT NOT NULL,
        content_type TEXT,
        received_at TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_link_inbounds_link ON agent_link_inbounds(link_id,received_at DESC);
      CREATE TABLE IF NOT EXISTS agent_link_events (
        sequence INTEGER PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES agent_links(id),
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS agent_link_events_no_update BEFORE UPDATE ON agent_link_events
      BEGIN SELECT RAISE(ABORT, 'agent link events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_link_events_no_delete BEFORE DELETE ON agent_link_events
      BEGIN SELECT RAISE(ABORT, 'agent link events are append-only'); END;
    `)
    this.ensureColumn('agent_links', 'validation_provider', 'TEXT')
    this.ensureColumn('agent_links', 'validated_at', 'TEXT')
    this.ensureColumn('agent_links', 'thread_id', 'TEXT')
    this.ensureColumn('agent_links', 'resource_id', 'TEXT')
    this.ensureColumn('agent_links', 'logo_path', 'TEXT')
    this.ensureColumn('agent_links', 'logo_media_type', 'TEXT')
    this.ensureColumn('agent_links', 'logo_text', 'TEXT')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!columns.some((candidate) => candidate.name === column)) this.db.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function cleanName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 160) throw new Error('Link name is required and must not exceed 160 characters')
  return name
}

function cleanLogoText(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  if (!cleaned) return undefined
  if (cleaned.length > 32) throw new Error('Link logo text must not exceed 32 characters')
  return cleaned
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  if (!cleaned) return undefined
  if (cleaned.length > 256) throw new Error('Link binding identifiers must not exceed 256 characters')
  return cleaned
}

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  if (!slug || slug.length > 96) throw new Error('Link slug must contain letters or numbers and must not exceed 96 characters')
  return slug
}

function normalizeLibrarySource(value: string): string {
  const normalized = posix.normalize(value.trim())
  if (!normalized.startsWith('/Library/')) throw new Error('Link source must be an AgentFS file under /Library')
  if (normalized.startsWith('/Library/Links/Published/')) throw new Error('Use a generated or uploaded source, not an already published Link snapshot')
  return normalized
}

function normalizeDraftManifestPath(value: string): string {
  const normalized = posix.normalize(value.trim())
  if (!/^\/Library\/Links\/Drafts\/[^/]+\/link\.json$/.test(normalized)) throw new Error('Link manifest must be a Papyrus AgentFS draft manifest')
  return normalized
}

export function validateSource(type: LinkType, mediaType: string): void {
  const baseType = normalizedMediaType(mediaType)
  if (type === 'webpage' && baseType !== 'text/html') throw new Error('Webpage Links require an HTML source file')
  if (type === 'api' && !['application/json', 'text/json'].includes(baseType)) throw new Error('API Links require a JSON source file')
  if (type === 'webhook' && !['application/json', 'text/json', 'text/plain', 'text/markdown'].includes(baseType)) {
    throw new Error('Webhook Links require a JSON, text, or Markdown contract file')
  }
}

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function safeAssetName(value: string): string {
  const name = posix.basename(value.trim()).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').slice(0, 180)
  if (!name || name === '.' || name === '..') throw new Error('Link asset name is invalid')
  return name
}

function validateManifest(value: unknown): LinkDraftManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Link draft manifest must be an object')
  const item = value as Record<string, unknown>
  if (item['formatVersion'] !== 1) throw new Error('Unsupported Link draft manifest version')
  const type = String(item['type'] ?? '') as LinkType
  if (!LINK_TYPES.includes(type)) throw new Error('Invalid Link type in draft manifest')
  const sourcePath = normalizeLibrarySource(String(item['sourcePath'] ?? ''))
  if (!sourcePath.startsWith('/Library/Links/Drafts/')) throw new Error('Link draft source must remain under /Library/Links/Drafts')
  const sourceSha256 = String(item['sourceSha256'] ?? '')
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Link draft source hash is invalid')
  const mediaType = String(item['mediaType'] ?? '')
  validateSource(type, mediaType)
  const workflowId = typeof item['workflowId'] === 'string' ? cleanOptional(item['workflowId']) : undefined
  const scheduleId = typeof item['scheduleId'] === 'string' ? cleanOptional(item['scheduleId']) : undefined
  const threadId = typeof item['threadId'] === 'string' ? cleanOptional(item['threadId']) : undefined
  const resourceId = typeof item['resourceId'] === 'string' ? cleanOptional(item['resourceId']) : undefined
  if (type === 'webhook' && (!threadId || !resourceId)) throw new Error('Webhook Link manifest is missing its session scope')
  const logoText = typeof item['logoText'] === 'string' ? cleanLogoText(item['logoText']) : undefined
  const draftId = String(item['draftId'] ?? '').trim()
  if (!draftId || draftId.length > 128) throw new Error('Link draft id is invalid')
  const createdAt = String(item['createdAt'] ?? '')
  if (Number.isNaN(new Date(createdAt).getTime())) throw new Error('Link draft creation time is invalid')
  let logo: LinkDraftAsset | undefined
  if (item['logo'] !== undefined) {
    const value = item['logo']
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Link draft logo must be an object')
    const candidate = value as Record<string, unknown>
    const name = safeAssetName(String(candidate['name'] ?? ''))
    const path = normalizeLibrarySource(String(candidate['path'] ?? ''))
    if (path !== `/Library/Links/Drafts/${draftId}/logo/${name}`) throw new Error('Link draft logo path is outside the draft logo boundary')
    const sha256 = String(candidate['sha256'] ?? '')
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Link draft logo hash is invalid')
    const mediaType = String(candidate['mediaType'] ?? '')
    if (!normalizedMediaType(mediaType).startsWith('image/')) throw new Error('Link draft logo must be an image')
    logo = { name, path, sha256, mediaType }
  }

  const rawAssets = Array.isArray(item['assets']) ? item['assets'] : []
  const assets = rawAssets.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Link draft asset must be an object')
    const asset = value as Record<string, unknown>
    const name = safeAssetName(String(asset['name'] ?? ''))
    const path = normalizeLibrarySource(String(asset['path'] ?? ''))
    if (path !== `/Library/Links/Drafts/${draftId}/assets/${name}`) throw new Error('Link draft asset path is outside the draft asset boundary')
    const sha256 = String(asset['sha256'] ?? '')
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Link draft asset hash is invalid')
    const mediaType = String(asset['mediaType'] ?? '')
    if (!normalizedMediaType(mediaType)) throw new Error('Link draft asset media type is invalid')
    return { name, path, sha256, mediaType }
  })
  return {
    formatVersion: 1,
    draftId,
    name: cleanName(String(item['name'] ?? '')),
    slug: normalizeSlug(String(item['slug'] ?? '')),
    type,
    sourcePath,
    sourceSha256,
    mediaType,
    createdAt,
    ...(workflowId ? { workflowId } : {}),
    ...(scheduleId ? { scheduleId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(logo ? { logo } : {}),
    ...(logoText ? { logoText } : {}),
    ...(assets.length ? { assets } : {}),
  }
}
