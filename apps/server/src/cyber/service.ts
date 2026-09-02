import type {
  EntraAppRole,
  IntegrationConfiguration,
  IntegrationEvent,
  PortalOverview,
  PortalPrincipal,
} from '@papyrus/contracts'
import { LicenseService } from '../license.js'
import { catalogEntry, INTEGRATION_CATALOG } from './catalog.js'
import type { CyberConfig } from './config.js'
import { CyberDatabase, type CreateIntegrationInput } from './database.js'
import { hasAppRole } from './entra-auth.js'

export class CyberServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const FORBIDDEN_SECRET_KEY = /(secret|password|token|api[_-]?key|private[_-]?key|client[_-]?secret)/i

function rejectInlineSecrets(value: unknown, path = 'settings'): void {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEY.test(key)) throw new CyberServiceError(400, 'INLINE_SECRET_REJECTED', `${path}.${key} must be a customer-vault reference, not secret material`)
    rejectInlineSecrets(item, `${path}.${key}`)
  }
}

function requireRole(principal: PortalPrincipal, role: EntraAppRole): void {
  if (!hasAppRole(principal, role)) throw new CyberServiceError(403, 'ENTRA_ROLE_REQUIRED', `${role} is required`)
}

function cleanText(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new CyberServiceError(400, 'INVALID_INPUT', `${name} is required and must not exceed ${maximum} characters`)
  return value.trim()
}

function optionalEndpoint(value: unknown, mode: CyberConfig['mode']): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const endpoint = cleanText(value, 'endpoint', 2048)
  let url: URL
  try { url = new URL(endpoint) } catch { throw new CyberServiceError(400, 'INVALID_ENDPOINT', 'endpoint must be a valid URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new CyberServiceError(400, 'INVALID_ENDPOINT', 'endpoint must be an HTTP(S) URL without credentials or a fragment')
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(mode === 'local' && loopback)) throw new CyberServiceError(400, 'INSECURE_ENDPOINT', 'endpoint must use HTTPS outside loopback development')
  return url.toString()
}

function optionalCredentialReference(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const reference = cleanText(value, 'credentialRef', 512)
  let url: URL
  try { url = new URL(reference) } catch {
    throw new CyberServiceError(400, 'INVALID_CREDENTIAL_REFERENCE', 'credentialRef must be an opaque customer-vault, certificate, or managed-identity URI')
  }
  if (!['vault:', 'keyvault:', 'secret:', 'cert:', 'managed-identity:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new CyberServiceError(400, 'INVALID_CREDENTIAL_REFERENCE', 'credentialRef must be an opaque customer-vault, certificate, or managed-identity URI')
  }
  return reference
}

export class CyberService {
  readonly license: LicenseService

  constructor(readonly db: CyberDatabase, readonly config: CyberConfig) {
    this.license = new LicenseService(db, config.dataDir, config.profile, config.licenseAuthorities, config.licenseRequired)
  }

  overview(principal: PortalPrincipal): PortalOverview {
    this.requirePortalAccess(principal)
    return {
      deployment: {
        profile: this.config.profile,
        topology: 'customer-hosted',
        identityAuthority: 'Microsoft Entra ID',
        runtime: 'Starlings',
        license: this.license.status(),
      },
      posture: this.db.posture(),
    }
  }

  catalog(principal: PortalPrincipal) {
    this.requirePortalAccess(principal)
    return INTEGRATION_CATALOG.filter((entry) => entry.supportedProfiles.includes(this.config.profile))
  }

  integrations(principal: PortalPrincipal): IntegrationConfiguration[] {
    this.requirePortalAccess(principal)
    return this.db.listIntegrations()
  }

  createIntegration(principal: PortalPrincipal, catalogId: unknown, input: Record<string, unknown>): IntegrationConfiguration {
    requireRole(principal, 'Papyrus.Integration.Manage')
    const entry = catalogEntry(cleanText(catalogId, 'catalogId', 128))
    if (!entry || !entry.supportedProfiles.includes(this.config.profile)) throw new CyberServiceError(400, 'CONNECTOR_UNAVAILABLE', 'Connector is not available for this deployment profile')
    this.license.require(entry.licenseFeature)
    const settings = input.settings === undefined ? {} : input.settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new CyberServiceError(400, 'INVALID_INPUT', 'settings must be an object')
    rejectInlineSecrets(settings)
    const credentialRef = optionalCredentialReference(input.credentialRef)
    const endpoint = optionalEndpoint(input.endpoint, this.config.mode)
    const create: CreateIntegrationInput = {
      name: cleanText(input.name ?? entry.name, 'name'),
      scope: cleanText(input.scope, 'scope', 512),
      settings: Object.fromEntries(Object.entries(settings as Record<string, unknown>).map(([key, value]) => {
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw new CyberServiceError(400, 'INVALID_INPUT', `settings.${key} must be a string, number, or boolean`)
        return [key, value as string | number | boolean]
      })),
      ...(endpoint ? { endpoint } : {}),
      ...(credentialRef ? { credentialRef } : {}),
    }
    return this.db.createIntegration(entry, create, principal.oid)
  }

  testIntegration(principal: PortalPrincipal, id: string): IntegrationConfiguration {
    requireRole(principal, 'Papyrus.Integration.Manage')
    const integration = this.integration(id)
    const entry = catalogEntry(integration.catalogId)
    if (!entry) throw new CyberServiceError(409, 'CONNECTOR_REMOVED', 'Connector manifest no longer exists')
    const requirements: string[] = []
    if (!entry.authSchemes.includes('none') && !integration.credentialRef && !entry.authSchemes.includes('entra')) requirements.push('credential reference or Entra application binding')
    if (['a2a-peer', 'acp-client', 'firewall-executor'].includes(entry.id) && !integration.endpoint) requirements.push('HTTPS endpoint')
    if (requirements.length) throw new CyberServiceError(409, 'CONFIGURATION_INCOMPLETE', `Configuration test requires ${requirements.join(' and ')}`)
    return this.db.markTested(id, principal.oid, {
      result: 'configuration_verified',
      networkReachability: 'not_tested',
      message: 'Manifest, scope, endpoint policy, and credential references passed deterministic validation.',
    })
  }

  submitIntegration(principal: PortalPrincipal, id: string): IntegrationConfiguration {
    requireRole(principal, 'Papyrus.Integration.Manage')
    this.integration(id)
    return this.db.submitForApproval(id, principal.oid)
  }

  activateIntegration(principal: PortalPrincipal, id: string): IntegrationConfiguration {
    const integration = this.integration(id)
    requireRole(principal, integration.risk === 'high' || integration.risk === 'critical' || integration.authority === 'controlled_actions'
      ? 'Papyrus.Security.Manage'
      : 'Papyrus.Integration.Manage')
    return this.db.activate(id, principal.oid)
  }

  disableIntegration(principal: PortalPrincipal, id: string, reason?: unknown): IntegrationConfiguration {
    const integration = this.integration(id)
    requireRole(principal, integration.authority === 'controlled_actions' ? 'Papyrus.Security.Manage' : 'Papyrus.Integration.Manage')
    return this.db.disable(id, principal.oid, reason === undefined ? undefined : cleanText(reason, 'reason', 512))
  }

  events(principal: PortalPrincipal, id: string): IntegrationEvent[] {
    requireRole(principal, 'Papyrus.Audit.View')
    this.integration(id)
    return this.db.listEvents(id)
  }

  requirePortalAccess(principal: PortalPrincipal): void {
    if (principal.roles.length === 0) throw new CyberServiceError(403, 'ENTRA_APP_ROLE_REQUIRED', 'Papyrus access must be assigned through an Entra application role')
  }

  private integration(id: string): IntegrationConfiguration {
    const integration = this.db.getIntegration(id)
    if (!integration) throw new CyberServiceError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found')
    return integration
  }
}
