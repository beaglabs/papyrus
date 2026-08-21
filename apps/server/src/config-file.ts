import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { CONNECTOR_PROFILES } from './catalog.js'

export interface FileConfig {
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
