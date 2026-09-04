export interface AgentFormField {
  name: string
  label: string
  kind: 'text' | 'url' | 'email' | 'credential_reference' | 'select'
  required: boolean
  placeholder?: string
  help?: string
  options?: Array<{ label: string; value: string }>
}

export interface ModelGatewayRequest {
  kind: 'model_gateway_request'
  fields: AgentFormField[]
  note: string
}

export function modelGatewayRequest(): ModelGatewayRequest {
  return {
    kind: 'model_gateway_request',
    fields: [
      { name: 'model', label: 'Model ID', kind: 'text', required: true, placeholder: 'qwen3-32b' },
      { name: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://inference.example.gov/v1', help: 'HTTPS is required outside loopback development.' },
      {
        name: 'authScheme',
        label: 'Authentication',
        kind: 'select',
        required: true,
        options: [
          { label: 'No authentication', value: 'none' },
          { label: 'API key from daemon environment', value: 'api_key' },
        ],
      },
      {
        name: 'credentialRef',
        label: 'API key environment variable',
        kind: 'credential_reference',
        required: false,
        placeholder: 'OPENAI_API_KEY',
        help: 'The daemon reads this variable at request time; the secret never enters chat or Papyrus storage.',
      },
    ],
    note: 'The daemon validates and tests the endpoint. The first gateway that passes becomes active automatically.',
  }
}
