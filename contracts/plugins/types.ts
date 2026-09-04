export const PLUGIN_INTEGRATION_CLASSES = ['human_interface', 'evidence_source', 'terrain_source', 'action_executor', 'agent_peer', 'infrastructure'] as const
export type PluginIntegrationClass = (typeof PLUGIN_INTEGRATION_CLASSES)[number]

export const PLUGIN_AUTHORITIES = ['read_only', 'bidirectional', 'controlled_actions'] as const
export type PluginAuthority = (typeof PLUGIN_AUTHORITIES)[number]

export const PLUGIN_RISKS = ['low', 'moderate', 'high', 'critical'] as const
export type PluginRisk = (typeof PLUGIN_RISKS)[number]

export const PLUGIN_SYNC_MODES = ['none', 'pull', 'push', 'hybrid'] as const
export type PluginSyncMode = (typeof PLUGIN_SYNC_MODES)[number]

export const PLUGIN_AUTH_SCHEMES = ['entra', 'certificate', 'managed_identity', 'oauth', 'mTLS', 'vault_reference', 'none'] as const
export type PluginAuthScheme = (typeof PLUGIN_AUTH_SCHEMES)[number]

export const PLUGIN_PROFILES = ['commercial', 'government-il4', 'government-il6', 'gcc', 'gcch', 'dod', 'restricted', 'disconnected'] as const
export type PluginProfile = (typeof PLUGIN_PROFILES)[number]

export const CONNECTED_PROFILES = ['commercial', 'government-il4', 'government-il6', 'gcc', 'gcch', 'dod', 'restricted'] as const satisfies readonly PluginProfile[]
export const ALL_PROFILES = [...CONNECTED_PROFILES, 'disconnected'] as const satisfies readonly PluginProfile[]
export const MICROSOFT_CLOUD_PROFILES = ['commercial', 'gcc', 'gcch', 'dod'] as const satisfies readonly PluginProfile[]

export interface PluginObservationSchemaContract {
  id: string
  evidenceType: string
  fixture: string
}

export interface PluginSecurityContract {
  credentials: 'none' | 'reference_only'
  outboundNetwork: 'none' | 'approved_endpoints_only'
  audit: 'required'
  provenance: 'required'
  failClosed: true
  actionApproval: 'required' | 'not_applicable'
}

export interface PluginConformanceContract {
  replay: 'required' | 'optional' | 'not_applicable'
  integration: 'required' | 'optional' | 'not_applicable'
  live: 'required' | 'optional' | 'not_applicable'
}

export interface PluginContract {
  id: string
  name: string
  vendor: string
  description: string
  integrationClass: PluginIntegrationClass
  authority: PluginAuthority
  risk: PluginRisk
  capabilities: readonly string[]
  evidenceTypes: readonly string[]
  syncMode: PluginSyncMode
  authSchemes: readonly PluginAuthScheme[]
  supportedProfiles: readonly PluginProfile[]
  licenseFeature: string
  requiredSettings?: readonly string[]
  observationSchemas?: readonly PluginObservationSchemaContract[]
  replayFixtures?: readonly string[]
  security: PluginSecurityContract
  conformance: PluginConformanceContract
}

export const READ_ONLY_PUSH_SECURITY = {
  credentials: 'reference_only',
  outboundNetwork: 'none',
  audit: 'required',
  provenance: 'required',
  failClosed: true,
  actionApproval: 'not_applicable',
} as const satisfies PluginSecurityContract

export const READ_ONLY_PULL_SECURITY = {
  credentials: 'reference_only',
  outboundNetwork: 'approved_endpoints_only',
  audit: 'required',
  provenance: 'required',
  failClosed: true,
  actionApproval: 'not_applicable',
} as const satisfies PluginSecurityContract

export const BIDIRECTIONAL_SECURITY = {
  credentials: 'reference_only',
  outboundNetwork: 'approved_endpoints_only',
  audit: 'required',
  provenance: 'required',
  failClosed: true,
  actionApproval: 'required',
} as const satisfies PluginSecurityContract

export const CONTROLLED_ACTION_SECURITY = {
  credentials: 'reference_only',
  outboundNetwork: 'approved_endpoints_only',
  audit: 'required',
  provenance: 'required',
  failClosed: true,
  actionApproval: 'required',
} as const satisfies PluginSecurityContract

export function definePluginContract<const T extends PluginContract>(contract: T): T {
  return contract
}

export function validatePluginContract(contract: PluginContract): string[] {
  const errors: string[] = []
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(contract.id)) errors.push('id must be kebab-case')
  if (!contract.name.trim()) errors.push('name is required')
  if (!contract.vendor.trim()) errors.push('vendor is required')
  if (!contract.description.trim()) errors.push('description is required')
  if (!contract.capabilities.length) errors.push('at least one capability is required')
  if (!contract.supportedProfiles.length) errors.push('at least one supported profile is required')
  if (!contract.authSchemes.length) errors.push('at least one authentication scheme is required')
  if (contract.security.audit !== 'required') errors.push('audit must be required')
  if (contract.security.provenance !== 'required') errors.push('provenance must be required')
  if (contract.security.failClosed !== true) errors.push('plugin must fail closed')
  if (contract.conformance.integration !== 'required') errors.push('integration conformance must be required')
  if (['controlled_actions', 'bidirectional'].includes(contract.authority) && contract.security.actionApproval !== 'required') {
    errors.push('outbound/action-capable plugins must require approval')
  }
  if (['evidence_source', 'terrain_source'].includes(contract.integrationClass) && contract.syncMode === 'push' && contract.security.outboundNetwork !== 'none') {
    errors.push('push-only evidence and terrain sources must not receive outbound network authority')
  }
  if (contract.authSchemes.some((scheme) => scheme !== 'none') && contract.security.credentials !== 'reference_only') {
    errors.push('credentialed plugins must use reference-only credentials')
  }
  if (contract.conformance.replay === 'required' && !(contract.replayFixtures?.length)) {
    errors.push('replay-required plugins must declare at least one fixture')
  }
  for (const schema of contract.observationSchemas ?? []) {
    if (!schema.id.trim()) errors.push('observation schema id is required')
    if (!schema.evidenceType.trim()) errors.push(`observation schema ${schema.id} must declare an evidence type`)
    if (!schema.fixture.trim()) errors.push(`observation schema ${schema.id} must declare a fixture`)
    if (contract.evidenceTypes.length && !contract.evidenceTypes.includes(schema.evidenceType)) {
      errors.push(`observation schema ${schema.id} evidence type must be declared by the plugin`)
    }
  }
  return errors
}
