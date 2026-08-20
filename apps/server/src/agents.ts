import type { RuntimeLaunchSpec } from '@papyrus/acp-runtime'
import { RUNTIME_PROFILES, isRuntimeProfileId, type RuntimeProfileId } from './catalog.js'

/** @deprecated Use RuntimeLaunchSpec. Kept while config routes migrate to the adapter catalog. */
export type AgentSpec = RuntimeLaunchSpec

/** Config-driven agent entry. `env` values may use {model} {baseUrl} {secret} {provider} placeholders. */
export interface AgentConfigEntry {
  profile: RuntimeProfileId
  environment?: Record<string, string>
}
function buildSpec(kind: string, entry: AgentConfigEntry): AgentSpec | undefined {
  if (!isRuntimeProfileId(entry.profile)) return undefined
  const profile = RUNTIME_PROFILES[entry.profile]
  return {
    kind,
    command: profile.command,
    args: [...profile.args],
    environment: () => ({ ...(entry.environment ?? {}) }),
  }
}

/** Resolves an agent kind to a launch + environment spec, from the built-in registry or config. */
export function resolveAgentSpec(kind: string, configured: Record<string, AgentConfigEntry> = {}): AgentSpec | undefined {
  const entry = configured[kind]
  if (entry) return buildSpec(kind, entry)
  if (isRuntimeProfileId(kind)) return buildSpec(kind, { profile: kind })
  return undefined
}
