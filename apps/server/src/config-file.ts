import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { AgentConfigEntry } from './agents.js'

export interface FileConfig {
  agents?: Record<string, AgentConfigEntry>
  licenseAuthorities?: Record<string, string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Loads declarative config from a YAML file; returns {} when absent or malformed. */
export function loadFileConfig(path: string | undefined): FileConfig {
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
      const spec: AgentConfigEntry = {}
      if (typeof entry.command === 'string') spec.command = entry.command
      if (Array.isArray(entry.args) && entry.args.every((item) => typeof item === 'string')) spec.args = entry.args as string[]
      if (isObject(entry.env)) {
        const env: Record<string, string> = {}
        for (const [name, value] of Object.entries(entry.env)) if (typeof value === 'string') env[name] = value
        if (Object.keys(env).length > 0) spec.env = env
      }
      agents[kind] = spec
    }
    if (Object.keys(agents).length > 0) config.agents = agents
  }

  if (isObject(parsed.licenseAuthorities)) {
    const authorities: Record<string, string> = {}
    for (const [keyId, pem] of Object.entries(parsed.licenseAuthorities)) if (typeof pem === 'string') authorities[keyId] = pem
    if (Object.keys(authorities).length > 0) config.licenseAuthorities = authorities
  }

  return config
}
