import type { ModelProviderConfig } from '@papyrus/agents/model-provider'
import { resolveModelProvider } from '@papyrus/agents/model-provider'
import { getDb } from './database.js'

export interface ModelRuntimeSettings {
  configured: boolean
  baseUrl: string
  model: string
  updatedAt?: string
}

export function getModelRuntimeSettings(organizationId: string): ModelRuntimeSettings {
  const row = getDb()
    .prepare('SELECT * FROM model_runtime_settings WHERE organization_id=?')
    .get(organizationId) as Record<string, unknown> | undefined
  if (!row) return { configured: false, baseUrl: '', model: 'phi-4-mini' }
  return {
    configured: true,
    baseUrl: String(row.base_url),
    model: String(row.model),
    updatedAt: String(row.updated_at),
  }
}

export function updateModelRuntimeSettings(
  organizationId: string,
  actor: string,
  input: { baseUrl?: unknown; model?: unknown },
): ModelRuntimeSettings {
  const baseUrl = String(input.baseUrl ?? '')
    .trim()
    .replace(/\/$/, '')
  const model = String(input.model ?? '').trim()
  const parsed = new URL(baseUrl)
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Model endpoint must use HTTP or HTTPS')
  if (!model) throw new Error('A model name is required')
  const now = new Date().toISOString()
  getDb()
    .prepare(`INSERT INTO model_runtime_settings (organization_id,base_url,model,updated_by,updated_at)
    VALUES (?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET
    base_url=excluded.base_url,model=excluded.model,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(organizationId, baseUrl, model, actor, now)
  return getModelRuntimeSettings(organizationId)
}

export function getModelRuntimeProvider(organizationId: string): ModelProviderConfig | null {
  const settings = getModelRuntimeSettings(organizationId)
  if (settings.configured)
    return {
      provider: 'openai-compatible',
      baseURL: settings.baseUrl,
      apiKey: 'local',
      model: settings.model,
    }
  return resolveModelProvider()
}
