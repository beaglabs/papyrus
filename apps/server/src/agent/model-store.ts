import { randomUUID } from 'node:crypto'
import { MODEL_AUTH_SCHEMES, MODEL_GATEWAY_KINDS } from '@papyrus/contracts'
import type {
  ModelAuthScheme,
  ModelGatewayKind,
  ModelProfile,
  ModelProfileState,
} from '@papyrus/contracts'
import { AgentDatabase } from './database.js'

type Row = Record<string, unknown>

export interface CreateModelProfileInput {
  name: string
  gatewayKind: ModelGatewayKind
  provider: string
  model: string
  baseUrl: string
  authScheme: ModelAuthScheme
  credentialRef?: string
  scope?: string
  capabilities?: string[]
}

export class ModelProfileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ModelProfileError'
  }
}

export class ModelStore {
  constructor(readonly db: AgentDatabase) { this.migrate() }

  list(): ModelProfile[] {
    return (this.db.sqlite.prepare('SELECT * FROM papyrus_model_profiles WHERE deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC').all() as Row[]).map((row) => this.profile(row))
  }

  get(id: string): ModelProfile | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM papyrus_model_profiles WHERE id=? AND deleted_at IS NULL').get(id) as Row | undefined
    return row ? this.profile(row) : undefined
  }

  getDefault(): ModelProfile | undefined {
    const row = this.db.sqlite.prepare("SELECT * FROM papyrus_model_profiles WHERE deleted_at IS NULL AND state='active' AND (last_tested_at IS NOT NULL OR is_default=1) ORDER BY is_default DESC, updated_at DESC LIMIT 1").get() as Row | undefined
    return row ? this.profile(row) : undefined
  }

  create(input: CreateModelProfileInput, actorOid: string, makeDefault = false): ModelProfile {
    const normalized = normalizeInput(input)
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.sqlite.transaction(() => {
      if (makeDefault) this.db.sqlite.prepare('UPDATE papyrus_model_profiles SET is_default=0,updated_at=? WHERE deleted_at IS NULL').run(now)
      this.db.sqlite.prepare(`INSERT INTO papyrus_model_profiles(
        id,name,gateway_kind,provider,model,base_url,auth_scheme,credential_ref,scope,capabilities_json,
        state,is_default,last_tested_at,last_test_error,created_by_oid,created_at,updated_at,version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,NULL,NULL,?,?,?,1)`).run(
        id, normalized.name, normalized.gatewayKind, normalized.provider, normalized.model, normalized.baseUrl,
        normalized.authScheme, normalized.credentialRef ?? null, normalized.scope, JSON.stringify(normalized.capabilities),
        'active', makeDefault ? 1 : 0, actorOid, now, now,
      )
      this.event(id, actorOid, 'ModelProfileCreated', { gatewayKind: normalized.gatewayKind, provider: normalized.provider, model: normalized.model, isDefault: makeDefault })
    })()
    return this.get(id) as ModelProfile
  }

  setDefault(id: string): ModelProfile {
    const profile = this.get(id)
    if (!profile) throw new ModelProfileError('MODEL_PROFILE_NOT_FOUND', 'Model profile not found')
    if (profile.state === 'error' || !profile.lastTestedAt) throw new ModelProfileError('MODEL_PROFILE_NOT_TESTED', 'Test the model gateway successfully before making it the default')
    const now = new Date().toISOString()
    this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare('UPDATE papyrus_model_profiles SET is_default=0,updated_at=?,version=version+1 WHERE deleted_at IS NULL').run(now)
      this.db.sqlite.prepare("UPDATE papyrus_model_profiles SET is_default=1,state='active',updated_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL").run(now, id)
      this.event(id, 'system:model-selection', 'ModelProfileDefaulted', {})
    })()
    return this.get(id) as ModelProfile
  }

  disable(id: string): ModelProfile {
    const profile = this.get(id)
    if (!profile) throw new ModelProfileError('MODEL_PROFILE_NOT_FOUND', 'Model profile not found')
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE papyrus_model_profiles SET state='disabled',is_default=0,updated_at=?,version=version+1 WHERE id=?").run(now, id)
    this.event(id, 'system:model-selection', 'ModelProfileDisabled', {})
    return this.get(id) as ModelProfile
  }

  delete(id: string, actorOid: string): void {
    const profile = this.get(id)
    if (!profile) throw new ModelProfileError('MODEL_PROFILE_NOT_FOUND', 'Model profile not found')
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE papyrus_model_profiles SET state='disabled',is_default=0,deleted_at=?,updated_at=?,version=version+1 WHERE id=?").run(now, now, id)
    this.db.sqlite.prepare(`INSERT INTO papyrus_model_profile_events(profile_id,actor_oid,action,occurred_at,data_json)
      VALUES(?,?,?,?,?)`).run(id, actorOid, 'ModelProfileDeleted', now, JSON.stringify({ credentialsRetainedByCustomer: true }))
  }

  markTested(id: string, error?: string, actorOid = 'system:model-test'): ModelProfile {
    const profile = this.get(id)
    if (!profile) throw new ModelProfileError('MODEL_PROFILE_NOT_FOUND', 'Model profile not found')
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE papyrus_model_profiles SET state=?,last_tested_at=?,last_test_error=?,updated_at=?,version=version+1 WHERE id=?")
      .run(error ? 'error' : 'active', now, error?.slice(0, 2048) ?? null, now, id)
    this.event(id, actorOid, error ? 'ModelProfileTestFailed' : 'ModelProfileTested', error ? { error: error.slice(0, 2048) } : {})
    return this.get(id) as ModelProfile
  }

  /** Import the legacy selector once, without importing any secret value. */
  bootstrapLegacy(env: NodeJS.ProcessEnv = process.env): ModelProfile | undefined {
    if (this.getDefault()) return this.getDefault()
    const selector = env.PAPYRUS_AGENT_MODEL?.trim() ?? env.PAPYRUS_INVESTIGATION_MODEL?.trim()
    if (!selector) return undefined
    const parts = selector.split('/').filter(Boolean)
    const provider = parts.shift() ?? 'openai-compatible'
    const model = parts.join('/') || provider
    const baseUrl = env.PAPYRUS_MODEL_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || defaultBaseUrl(provider)
    const credentialRef = env.PAPYRUS_MODEL_CREDENTIAL_REF?.trim() || (env.OPENAI_API_KEY ? 'env://OPENAI_API_KEY' : undefined)
    return this.create({
      name: `Imported ${selector}`,
      gatewayKind: provider === 'azure' ? 'azure-openai' : 'openai-compatible', provider, model, baseUrl,
      authScheme: credentialRef ? 'credential_ref' : 'none', ...(credentialRef ? { credentialRef } : {}),
      scope: 'daemon', capabilities: ['chat', 'streaming', 'tools', 'structured_outputs'],
    }, 'system:legacy-import', true)
  }

  private profile(row: Row): ModelProfile {
    return {
      id: String(row.id), name: String(row.name), gatewayKind: row.gateway_kind as ModelGatewayKind,
      provider: String(row.provider), model: String(row.model), baseUrl: String(row.base_url),
      authScheme: row.auth_scheme as ModelAuthScheme, ...(row.credential_ref ? { credentialRef: String(row.credential_ref) } : {}),
      scope: String(row.scope), capabilities: JSON.parse(String(row.capabilities_json)) as string[],
      state: row.state as ModelProfileState, isDefault: Boolean(row.is_default),
      ...(row.last_tested_at ? { lastTestedAt: String(row.last_tested_at) } : {}),
      ...(row.last_test_error ? { lastTestError: String(row.last_test_error) } : {}),
      createdByOid: String(row.created_by_oid), createdAt: String(row.created_at), updatedAt: String(row.updated_at), version: Number(row.version),
    }
  }

  private event(profileId: string, actorOid: string, action: string, data: Record<string, unknown>): void {
    this.db.sqlite.prepare(`INSERT INTO papyrus_model_profile_events(profile_id,actor_oid,action,occurred_at,data_json)
      VALUES(?,?,?,?,?)`).run(profileId, actorOid, action, new Date().toISOString(), JSON.stringify(data))
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS papyrus_model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        gateway_kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT NOT NULL,
        auth_scheme TEXT NOT NULL,
        credential_ref TEXT,
        scope TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','disabled','error')),
        is_default INTEGER NOT NULL DEFAULT 0,
        last_tested_at TEXT,
        last_test_error TEXT,
        created_by_oid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS papyrus_model_profiles_default ON papyrus_model_profiles(is_default,state,updated_at DESC);
      CREATE TABLE IF NOT EXISTS papyrus_model_profile_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        actor_oid TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
    `)
  }
}

function normalizeInput(input: CreateModelProfileInput): CreateModelProfileInput & { scope: string; capabilities: string[] } {
  const name = clean(input.name, 'name', 120)
  const provider = clean(input.provider, 'provider', 120).toLowerCase()
  const model = clean(input.model, 'model', 256)
  const scope = clean(input.scope ?? 'daemon', 'scope', 256)
  if (!MODEL_GATEWAY_KINDS.includes(input.gatewayKind)) throw new ModelProfileError('INVALID_MODEL_PROFILE', 'Unsupported gateway kind')
  if (!MODEL_AUTH_SCHEMES.includes(input.authScheme)) throw new ModelProfileError('INVALID_MODEL_PROFILE', 'Unsupported authentication scheme')
  let base: URL
  try { base = new URL(clean(input.baseUrl, 'baseUrl', 2048)) }
  catch { throw new ModelProfileError('INVALID_MODEL_BASE_URL', 'baseUrl must be an HTTP(S) URL without credentials, query, or fragment') }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new ModelProfileError('INVALID_MODEL_BASE_URL', 'baseUrl must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new ModelProfileError('INSECURE_MODEL_BASE_URL', 'HTTP model endpoints are only allowed on loopback; use HTTPS elsewhere')
  }
  const credentialRef = input.credentialRef?.trim()
  if (input.authScheme !== 'none' && !credentialRef) throw new ModelProfileError('CREDENTIAL_REFERENCE_REQUIRED', 'A credential reference is required for this authentication mode')
  if (credentialRef && !/^(env|vault|keyvault|secret|cert|managed-identity):\/\//i.test(credentialRef)) {
    throw new ModelProfileError('INVALID_CREDENTIAL_REFERENCE', 'credentialRef must be an env, vault, certificate, or managed-identity URI')
  }
  return {
    ...input, name, provider, model, scope, baseUrl: base.toString().replace(/\/$/, ''),
    ...(credentialRef ? { credentialRef } : {}), capabilities: [...new Set((input.capabilities ?? ['chat', 'streaming', 'tools']).map((value) => clean(value, 'capability', 64)))],
  }
}

function clean(value: string, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ModelProfileError('INVALID_MODEL_PROFILE', `${field} is required`)
  return value.trim()
}

function defaultBaseUrl(provider: string): string {
  if (provider === 'ollama') return 'http://127.0.0.1:11434/v1'
  return 'https://api.openai.com/v1'
}
