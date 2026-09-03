import type { IntegrationCatalogEntry } from '@papyrus/contracts'

export interface PluginField {
  name: string
  label: string
  kind: 'text' | 'url' | 'email' | 'credential_reference' | 'select'
  required: boolean
  placeholder?: string
  help?: string
  options?: Array<{ label: string; value: string }>
}

export interface PluginConnectionRequest {
  kind: 'plugin_connection_request'
  catalogId: string
  name: string
  description: string
  authority: IntegrationCatalogEntry['authority']
  risk: IntegrationCatalogEntry['risk']
  syncMode: IntegrationCatalogEntry['syncMode']
  acceptsSignals: boolean
  fields: PluginField[]
  note: string
}

export interface ModelGatewayRequest {
  kind: 'model_gateway_request'
  fields: PluginField[]
  note: string
}

export function modelGatewayRequest(): ModelGatewayRequest {
  return {
    kind: 'model_gateway_request',
    fields: [
      { name: 'name', label: 'Display name', kind: 'text', required: true, placeholder: 'Local operations model' },
      { name: 'gatewayKind', label: 'Gateway type', kind: 'select', required: true, options: [
        { label: 'OpenAI-compatible', value: 'openai-compatible' }, { label: 'Azure OpenAI / Entra', value: 'azure-openai' },
        { label: 'Ollama / local', value: 'ollama' }, { label: 'Custom compatible gateway', value: 'custom' },
      ] },
      { name: 'provider', label: 'Provider name', kind: 'text', required: true, placeholder: 'openai-compatible', help: 'A stable provider label used in the gateway catalog.' },
      { name: 'model', label: 'Model ID', kind: 'text', required: true, placeholder: 'qwen3-32b' },
      { name: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://inference.example.gov/v1', help: 'HTTPS is required outside loopback development.' },
      { name: 'authScheme', label: 'Authentication', kind: 'select', required: true, options: [
        { label: 'No authentication', value: 'none' }, { label: 'API key reference', value: 'api_key' },
        { label: 'Microsoft Entra / managed identity', value: 'entra' }, { label: 'Customer credential reference', value: 'credential_ref' },
      ] },
      { name: 'credentialRef', label: 'Credential reference', kind: 'credential_reference', required: false, placeholder: 'env://OPENAI_API_KEY', help: 'Use env://, vault://, keyvault://, cert://, or managed-identity://. Secret material never enters chat.' },
      { name: 'scope', label: 'Deployment scope', kind: 'text', required: true, placeholder: 'Organization or enclave' },
      { name: 'makeDefault', label: 'Use as default', kind: 'select', required: true, options: [{ label: 'Make default', value: 'true' }, { label: 'Keep current default', value: 'false' }] },
    ],
    note: 'The daemon validates the endpoint, records only non-secret metadata, tests the gateway, and can make it the active Papyrus model.',
  }
}

/**
 * The agent can decide which plugin fits a task, but the browser owns the
 * credential form. Tool output contains a form description, never a secret.
 */
export function connectionRequest(entry: IntegrationCatalogEntry): PluginConnectionRequest {
  const fields: PluginField[] = [
    { name: 'name', label: 'Display name', kind: 'text', required: true, placeholder: entry.name },
    { name: 'scope', label: 'Operational scope', kind: 'text', required: true, placeholder: 'Organization or enclave' },
  ]

  if (entry.id === 'exchange-email') {
    fields.push({
      name: 'mailbox', label: 'Mailbox', kind: 'email', required: true,
      placeholder: 'operations@example.gov', help: 'Mailbox used for inbound tasks and approved outbound notifications.',
    })
  }

  if (!entry.observationProtocol && entry.syncMode !== 'none') {
    fields.push({
      name: 'endpoint', label: 'Endpoint', kind: 'url', required: false,
      placeholder: 'https://approved.internal.example/api', help: 'Leave blank when the deployment cloud endpoint is selected automatically.',
    })
  } else if (['a2a-peer', 'acp-client', 'firewall-executor'].includes(entry.id)) {
    fields.push({ name: 'endpoint', label: 'Endpoint', kind: 'url', required: true, placeholder: 'https://approved.internal.example/api' })
  }

  if (!entry.authSchemes.includes('none')) {
    fields.push({
      name: 'credentialRef', label: 'Credential reference', kind: 'credential_reference', required: false,
      placeholder: 'keyvault://papyrus/plugins/example',
      help: 'Reference a customer vault, certificate, or managed identity. Secret material is never sent through the agent.',
    })
  }

  if (!entry.observationProtocol) {
    fields.push({
      name: 'dataHandling', label: 'Data handling', kind: 'select', required: true,
      options: [
        { label: 'Metadata only', value: 'metadata_only' },
        { label: 'Normalized events', value: 'normalized_events' },
        { label: 'Customer defined', value: 'customer_defined' },
      ],
    })
  }

  return {
    kind: 'plugin_connection_request',
    catalogId: entry.id,
    name: entry.name,
    description: entry.description,
    authority: entry.authority,
    risk: entry.risk,
    syncMode: entry.syncMode,
    acceptsSignals: Boolean(entry.observationProtocol || entry.syncMode === 'push' || entry.syncMode === 'hybrid'),
    fields,
    note: entry.observationProtocol
      ? 'The daemon will create a source-scoped webhook after this form is submitted.'
      : 'The daemon validates the configuration before any authority is activated.',
  }
}

export function pluginToolId(entry: IntegrationCatalogEntry): string {
  return `connect_${entry.id.replaceAll('-', '_')}`
}
