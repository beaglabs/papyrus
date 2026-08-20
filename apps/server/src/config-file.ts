import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { AgentConfigEntry } from './agents.js'
import { CONNECTOR_PROFILES, isRuntimeProfileId } from './catalog.js'

export interface FileConfig {
  agents?: Record<string, AgentConfigEntry>
  connectors?: string[]
  licenseAuthorities?: Record<string, string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Loads declarative config from a YAML file; returns {} when absent or malformed. */
export function loadFileConfig(path: string | undefined, environment: NodeJS.ProcessEnv = process.env): FileConfig {
  if (!path) return {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const parsed = parse(text) as unknown
  if (!isObject(parsed)) return {}

  const config: FileConfig = {}

  if (isObject(parsed.agents)) {
    const agents: Record<string, AgentConfigEntry> = {}
    for (const [kind, entry] of Object.entries(parsed.agents)) {
      if (!isObject(entry)) continue
      if (typeof entry.profile !== 'string' || !isRuntimeProfileId(entry.profile)) continue
      const spec: AgentConfigEntry = { profile: entry.profile }
      if (isObject(entry.environment)) {
        const resolved: Record<string, string> = {}
        for (const [name, source] of Object.entries(entry.environment)) {
          if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof source !== 'string' || !/^PAPYRUS_SECRET_[A-Z0-9_]+$/.test(source)) continue
          if (environment[source] !== undefined) resolved[name] = environment[source] as string
        }
        if (Object.keys(resolved).length > 0) spec.environment = resolved
      }
      agents[kind] = spec
    }
    if (Object.keys(agents).length > 0) config.agents = agents
  }

  if (Array.isArray(parsed.connectors)) {
    const connectors = [...new Set(parsed.connectors.filter((value): value is string => typeof value === 'string' && value in CONNECTOR_PROFILES))]
    if (connectors.length > 0) config.connectors = connectors
  }

  if (isObject(parsed.licenseAuthorities)) {
    const authorities: Record<string, string> = {}
    for (const [keyId, pem] of Object.entries(parsed.licenseAuthorities)) if (typeof pem === 'string') authorities[keyId] = pem
    if (Object.keys(authorities).length > 0) config.licenseAuthorities = authorities
  }

  return config
}
