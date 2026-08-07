/**
 * Config loader — reads `~/.papyrus/config.json` (or `PAPYRUS_CONFIG` override),
 * merges with profile defaults, and validates.
 *
 * Profile is resolved from (in priority order):
 *   1. CLI flag `--profile`
 *   2. `PAPYRUS_PROFILE` env var
 *   3. `profile` field in config file
 *   4. default: 'commercial'
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AuthMethod,
  AuthProviderConfig,
  NetworkProfile,
  PapyrusConfig,
} from '../profiles/config.js'
import { type Env, resolveProfile } from '../profiles/config.js'
import { defaultConfig } from '../profiles/defaults.js'

/** Shape of the user-facing config file. All fields optional (defaults fill in). */
export interface ConfigFile {
  profile?: NetworkProfile
  auth?: { allowed?: AuthMethod[]; providers?: AuthProviderConfig }
  llm?: { endpoint?: string; model?: string; apiKeyEnv?: string }
  sync?: { peers?: string[]; allowInternet?: boolean }
  features?: { agents?: boolean; crossDomainExport?: boolean }
}

export type { PapyrusConfig }

const DEFAULT_CONFIG_DIR = join(process.env.HOME ?? '~', '.papyrus')
const CONFIG_FILE = 'config.json'

export const CONFIG_ENV = {
  profile: 'PAPYRUS_PROFILE',
  configPath: 'PAPYRUS_CONFIG',
} as const

/** Resolve the config file path. */
export function resolveConfigPath(env: Env = process.env): string {
  return env[CONFIG_ENV.configPath] ?? join(DEFAULT_CONFIG_DIR, CONFIG_FILE)
}

/** Load the config file from disk. Returns null if not found or malformed. */
export function loadConfigFile(path: string): ConfigFile | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as ConfigFile
  } catch {
    return null
  }
}

/** Merge a user config file with profile defaults. */
function mergeConfig(file: ConfigFile | null, profile: NetworkProfile): PapyrusConfig {
  const defaults = defaultConfig(profile)
  if (!file) return defaults

  return {
    profile,
    auth: {
      allowed: file.auth?.allowed ?? defaults.auth.allowed,
      providers: file.auth?.providers ?? {},
    },
    llm: file.llm?.endpoint
      ? {
          endpoint: file.llm.endpoint,
          model: file.llm.model ?? defaults.llm?.model ?? '',
          apiKeyEnv: file.llm.apiKeyEnv,
        }
      : defaults.llm,
    sync: {
      peers: file.sync?.peers ?? defaults.sync.peers,
      allowInternet: file.sync?.allowInternet ?? defaults.sync.allowInternet,
    },
    features: {
      agents: file.features?.agents ?? defaults.features.agents,
      crossDomainExport: file.features?.crossDomainExport ?? defaults.features.crossDomainExport,
    },
  }
}

/** Validate a merged config. Returns an array of errors (empty = valid). */
export function validateConfig(config: PapyrusConfig): string[] {
  const errors: string[] = []
  const validProfiles: NetworkProfile[] = ['commercial', 'niprnet-il4', 'siprnet-il6']
  if (!validProfiles.includes(config.profile)) {
    errors.push(`Invalid profile: "${config.profile}"`)
  }
  const validMethods: AuthMethod[] = ['cac-piv', 'webauthn', 'oidc', 'saml']
  for (const m of config.auth.allowed) {
    if (!validMethods.includes(m)) errors.push(`Invalid auth method: "${m}"`)
  }
  if (config.llm) {
    if (!config.llm.endpoint.startsWith('http')) {
      errors.push(`LLM endpoint must be an HTTP(S) URL, got: "${config.llm.endpoint}"`)
    }
  }
  return errors
}

/**
 * Full config resolution: load file → merge with defaults → validate.
 * Returns the merged config. Throws if the config file exists but is invalid.
 */
export function resolveConfig(env: Env = process.env, cliProfile?: string): PapyrusConfig {
  const profileOverride = cliProfile ? cliProfile.toLowerCase() : undefined
  const configFile = loadConfigFile(resolveConfigPath(env))

  // Profile priority: CLI flag > env > config file > default
  let profile: NetworkProfile
  if (profileOverride) {
    profile = profileOverride as NetworkProfile
  } else if (env[CONFIG_ENV.profile]) {
    profile = resolveProfile(env)
  } else if (configFile?.profile) {
    profile = configFile.profile
  } else {
    profile = 'commercial'
  }

  const config = mergeConfig(configFile, profile)
  const errors = validateConfig(config)
  if (errors.length > 0 && configFile) {
    throw new Error(`Invalid config at ${resolveConfigPath(env)}:\n  ${errors.join('\n  ')}`)
  }
  return config
}
