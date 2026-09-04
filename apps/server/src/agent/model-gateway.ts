import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type {
  GatewayAuthRequest,
  GatewayAuthResult,
  GatewayLanguageModel,
  MastraModelGatewayInterface,
  ProviderConfig,
} from '@mastra/core/llm'
import type { ModelProfile } from '@papyrus/contracts'
import { ModelStore } from './model-store.js'

/**
 * One stable Mastra gateway fronts all customer-configured model profiles.
 * Profiles are metadata only; resolveAuth is the only place that materializes
 * a credential, and the default resolver supports env:// references so a
 * customer can bind a vault/workload-identity adapter without changing the
 * model ID or agent code.
 */
export class PapyrusModelGateway implements MastraModelGatewayInterface {
  readonly id = 'papyrus'
  readonly name = 'Papyrus customer model gateways'

  constructor(private readonly profiles: ModelStore) {}

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return Object.fromEntries(this.profiles.list().filter((profile) => profile.state === 'active').map((profile) => [profile.id, {
      name: profile.name,
      models: [profile.model],
      apiKeyEnvVar: 'PAPYRUS_MODEL_CREDENTIAL',
      gateway: this.id,
      url: profile.baseUrl,
      docUrl: profile.baseUrl,
    }]))
  }

  buildUrl(modelId: string): string | undefined {
    const profile = this.findProfile(modelId)
    return profile?.baseUrl
  }

  async getApiKey(modelId: string): Promise<string> {
    const profile = this.findProfile(modelId)
    if (!profile) throw new Error('Configured Papyrus model profile not found')
    return resolveModelCredential(profile)
  }

  async resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult | undefined> {
    const profile = this.profiles.get(request.providerId)
    if (!profile || profile.state !== 'active') return undefined
    const credential = resolveModelCredential(profile)
    if (profile.authScheme === 'none') return { source: 'gateway' }
    return { apiKey: credential, source: 'gateway' }
  }

  resolveLanguageModel({ modelId, providerId, apiKey, headers }: {
    modelId: string
    providerId: string
    apiKey: string
    headers?: Record<string, string>
  }): GatewayLanguageModel {
    const profile = this.profiles.get(providerId)
    if (!profile || profile.state !== 'active') throw new Error('Configured Papyrus model profile not found')
    const provider = createOpenAICompatible({
      name: `papyrus.${providerId}`,
      baseURL: profile.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(headers && Object.keys(headers).length ? { headers } : {}),
      supportsStructuredOutputs: profile.capabilities.includes('structured_outputs'),
    })
    return provider.chatModel(modelId)
  }

  private findProfile(modelId: string): ModelProfile | undefined {
    const [, providerId] = modelId.split('/')
    return providerId ? this.profiles.get(providerId) : this.profiles.get(modelId)
  }
}

export function resolveModelCredential(profile: ModelProfile): string {
  if (profile.authScheme === 'none') return ''
  const reference = profile.credentialRef
  if (!reference) throw new Error(`Missing credential reference for model profile ${profile.name}`)
  if (reference.toLowerCase().startsWith('env://')) {
    const variable = reference.slice('env://'.length)
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(variable)) throw new Error('Environment credential reference is invalid')
    const value = process.env[variable]
    if (!value) throw new Error(`Missing ${variable} environment variable for model profile ${profile.name}`)
    return value
  }
  throw new Error(`Credential reference scheme is not configured for model profile ${profile.name}`)
}
