import { describe, expect, it } from 'vitest'
import { loadAgentConfig } from '../src/agent/config.js'
import { FORBIDDEN_AGENT_TOOLS, INVESTIGATION_TOOLS, assertAgentSafeTool } from '../src/agent/mastra/tools.js'
import { SandboxUnavailableError, assertUsableSandbox, resolveSandboxPolicy } from '../src/agent/mastra/sandbox-policy.js'
import { normalizeWorkspaceCwd, workspaceEnvironment } from '../src/agent/mastra/workspace-nono.js'

const localEnv = {
  PAPYRUS_MODE: 'local',
  PAPYRUS_PORTAL_SECRET: 'development-portal-secret',
  PAPYRUS_DEV_ENTRA_PRINCIPAL: JSON.stringify({ oid: 'dev', tenantId: 'tenant', displayName: 'Developer', roles: [] }),
}

describe('pre-commit security invariants', () => {
  it('keeps government cloud selection explicit and rejects unknown sandbox backends', () => {
    expect(loadAgentConfig({ ...localEnv, PAPYRUS_PROFILE: 'government', PAPYRUS_ENTRA_CLOUD: 'USGov' }).cloud).toBe('USGov')
    expect(loadAgentConfig({ ...localEnv, PAPYRUS_PROFILE: 'government', PAPYRUS_ENTRA_CLOUD: 'USGovDoD' }).cloud).toBe('USGovDoD')
    expect(() => loadAgentConfig({ ...localEnv, PAPYRUS_SANDBOX_RUNTIME: 'docker' })).toThrow(/bwrap or seatbelt/)
  })

  it('keeps agent investigation tools read-only and approval/execution out of the agent', () => {
    for (const descriptor of Object.values(INVESTIGATION_TOOLS)) expect(descriptor.authority).toBe('read_only')
    for (const tool of FORBIDDEN_AGENT_TOOLS) expect(() => assertAgentSafeTool(tool)).toThrow()
    expect(() => assertAgentSafeTool('terrainQuery')).not.toThrow()
  })

  it('fails closed rather than running code without OS isolation', () => {
    const unavailable = resolveSandboxPolicy({ dataDir: '/srv/papyrus', platform: 'linux', canRun: () => false })
    expect(unavailable).toMatchObject({ enabled: false, isolation: 'none', allowNetwork: false })
    expect(() => assertUsableSandbox(unavailable)).toThrow(SandboxUnavailableError)
    const isolated = resolveSandboxPolicy({ dataDir: '/srv/papyrus', platform: 'linux', canRun: () => true })
    expect(isolated).toMatchObject({ enabled: true, isolation: 'bwrap', allowNetwork: false })
  })

  it('strips credential-like environment values from workspace commands', () => {
    const env = workspaceEnvironment('/tmp/papyrus-workspace', {
      SAFE_VALUE: 'ok', GITHUB_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', PASSWORD: 'secret', API_KEY: 'secret',
    })
    expect(env.SAFE_VALUE).toBe('ok')
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.PASSWORD).toBeUndefined()
    expect(env.API_KEY).toBeUndefined()
  })

  it('rejects workspace cwd traversal', () => {
    expect(normalizeWorkspaceCwd('/Workspace')).toBe('/Workspace')
    expect(() => normalizeWorkspaceCwd('../../etc')).toThrow(/escapes AgentFS workspace/)
  })
})
