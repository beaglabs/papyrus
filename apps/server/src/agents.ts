export interface AgentSpec {
  kind: string
  command: string
  args: string[]
  environment(): Record<string, string>
}

/** Config-driven agent entry. `env` values may use {model} {baseUrl} {secret} {provider} placeholders. */
export interface AgentConfigEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

const GOOSE_SPEC: AgentSpec = { kind: 'goose', command: 'goose', args: ['acp'], environment: () => ({}) }

function templateEnvironment(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    out[name] = value.replace(/\{(model|baseUrl|secret|provider)\}/g, (_match, _key: string) => '')
  }
  return out
}

function buildSpec(kind: string, entry: AgentConfigEntry): AgentSpec {
  return {
    kind,
    command: entry.command ?? kind,
    args: entry.args ?? ['acp'],
    environment: () => entry.env ? templateEnvironment(entry.env as Record<string, string>) : {},
  }
}

/** Resolves an agent kind to a launch + environment spec, from the built-in registry or config. */
export function resolveAgentSpec(kind: string, configured: Record<string, AgentConfigEntry> = {}): AgentSpec | undefined {
  const entry = configured[kind]
  if (entry) return buildSpec(kind, entry)
  if (kind === 'goose') return GOOSE_SPEC
  return undefined
}
