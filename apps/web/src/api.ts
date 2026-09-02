import type {
  IntegrationCatalogEntry,
  IntegrationConfiguration,
  IntegrationEvent,
  PortalOverview,
  PortalPrincipal,
  SyncJob,
  TerrainSnapshot,
} from '@papyrus/contracts'

export interface PublicConfig {
  organizationName: string
  profile: string
  cloud: 'Public' | 'USGov' | 'USGovDoD'
  entraConfigured: boolean
  developmentIdentity: boolean
  loginUrl: string
}

export interface PortalData {
  config: PublicConfig
  me: PortalPrincipal
  overview: PortalOverview
  catalog: IntegrationCatalogEntry[]
  integrations: IntegrationConfiguration[]
  terrain: TerrainSnapshot
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export class AuthenticationRequired extends ApiError {
  constructor() { super(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required') }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const result = await response.json().catch(() => null) as T | { error?: string; code?: string }
  if (!response.ok) {
    if (response.status === 401) throw new AuthenticationRequired()
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `Request failed (${response.status})`
    const code = result && typeof result === 'object' && 'code' in result && typeof result.code === 'string' ? result.code : 'REQUEST_FAILED'
    throw new ApiError(response.status, code, message)
  }
  return result as T
}

export async function loadPortal(): Promise<PortalData> {
  const config = await api<PublicConfig>('/api/config/public')
  const [me, overview, catalog, integrations, terrain] = await Promise.all([
    api<PortalPrincipal>('/api/me'),
    api<PortalOverview>('/api/portal/overview'),
    api<{ integrations: IntegrationCatalogEntry[] }>('/api/integrations/catalog'),
    api<{ integrations: IntegrationConfiguration[] }>('/api/integrations'),
    api<TerrainSnapshot>('/api/terrain'),
  ])
  return { config, me, overview, catalog: catalog.integrations, integrations: integrations.integrations, terrain }
}

export async function publicConfig(): Promise<PublicConfig> { return api('/api/config/public') }

export async function createIntegration(input: {
  catalogId: string
  name: string
  endpoint?: string
  scope: string
  credentialRef?: string
  settings: Record<string, string | number | boolean>
}): Promise<IntegrationConfiguration> {
  return api('/api/integrations', { method: 'POST', body: JSON.stringify(input) })
}

export async function transitionIntegration(id: string, action: 'test' | 'submit' | 'activate' | 'disable', reason?: string): Promise<IntegrationConfiguration> {
  return api(`/api/integrations/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', body: JSON.stringify(reason ? { reason } : {}),
  })
}

export async function integrationEvents(id: string): Promise<IntegrationEvent[]> {
  return (await api<{ events: IntegrationEvent[] }>(`/api/integrations/${encodeURIComponent(id)}/events`)).events
}

export async function requestIntegrationSync(id: string): Promise<SyncJob> {
  return api(`/api/integrations/${encodeURIComponent(id)}/sync`, { method: 'POST', body: '{}' })
}

export async function logout(): Promise<void> { await api('/api/auth/logout', { method: 'POST', body: '{}' }) }
