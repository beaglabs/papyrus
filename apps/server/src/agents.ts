import type { ModelEndpoint } from '@papyrus/contracts'

export interface AgentSpec {
  kind: string
  command: string
  args: string[]
  environment(model: ModelEndpoint, secret: string): Record<string, string>
}

/** Config-driven agent entry. `env` values may use {model} {baseUrl} {secret} {provider} placeholders. */
export interface AgentConfigEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

const gooseEnvironment = (model: ModelEndpoint, secret: string): Record<string, string> => {
  const common = { GOOSE_MODEL: model.model }
  if (model.provider === 'openai-compatible') return { ...common, GOOSE_PROVIDER: 'openai', OPENAI_HOST: model.baseUrl, OPENAI_API_KEY: secret }
  if (model.provider === 'azure-openai') return { ...common, GOOSE_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: model.baseUrl, AZURE_OPENAI_API_KEY: secret }
  return { ...common, GOOSE_PROVIDER: 'anthropic', ANTHROPIC_HOST: model.baseUrl, ANTHROPIC_API_KEY: secret }
}

const GOOSE_SPEC: AgentSpec = { kind: 'goose', command: 'goose', args: ['acp'], environment: gooseEnvironment }

function templateEnvironment(env: Record<string, string>, model: ModelEndpoint, secret: string): Record<string, string> {
  const vars: Record<string, string> = { model: model.model, baseUrl: model.baseUrl, secret, provider: model.provider }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    out[name] = value.replace(/\{(model|baseUrl|secret|provider)\}/g, (_match, key: string) => vars[key] ?? '')
  }
  return out
}

function buildSpec(kind: string, entry: AgentConfigEntry): AgentSpec {
  if (!entry.env) throw new Error(`Agent "${kind}" requires an "env" template in PAPYRUS_AGENTS_JSON`)
  return {
    kind,
    command: entry.command ?? kind,
    args: entry.args ?? ['acp'],
    environment: (model, secret) => templateEnvironment(entry.env as Record<string, string>, model, secret),
  }
}

/** Resolves a runtime kind to a launch + environment spec, from the built-in registry or config. */
export function resolveAgentSpec(kind: string, configured: Record<string, AgentConfigEntry> = {}): AgentSpec | undefined {
  const entry = configured[kind]
  if (entry) return buildSpec(kind, entry)
  if (kind === 'goose') return GOOSE_SPEC
  return undefined
}
