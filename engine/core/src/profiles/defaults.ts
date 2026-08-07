import { type NetworkProfile, type PapyrusConfig, authMethodsFor } from './config.js'

/**
 * Default config per profile. IL6 is the most locked-down: CAC/PIV only, no
 * internet sync, agents off until an on-prem LLM endpoint is configured, and
 * cross-domain export disabled. Commercial is the inverse.
 */
export function defaultConfig(profile: NetworkProfile): PapyrusConfig {
  const base: PapyrusConfig = {
    profile,
    auth: { allowed: authMethodsFor(profile), providers: {} },
    llm: null,
    sync: { peers: [], allowInternet: false },
    features: { agents: false, crossDomainExport: false },
  }

  switch (profile) {
    case 'commercial':
      return {
        ...base,
        llm: {
          endpoint: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          apiKeyEnv: 'OPENAI_API_KEY',
        },
        sync: { peers: [], allowInternet: true },
        features: { agents: true, crossDomainExport: true },
      }
    case 'niprnet-il4':
      return {
        ...base,
        llm: null,
        sync: { peers: [], allowInternet: false },
        features: { agents: false, crossDomainExport: true },
      }
    case 'siprnet-il6':
      return {
        ...base,
        llm: null,
        sync: { peers: [], allowInternet: false },
        features: { agents: false, crossDomainExport: false },
      }
  }
}
