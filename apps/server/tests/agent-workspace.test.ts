import { describe, expect, it } from 'vitest'
import { agentFsMountBackend, minimalEnvironment, PapyrusAgentFSFilesystem } from '../src/agent/mastra/workspace-agentfs.js'
import { buildNonoLaunchPlan } from '../src/agent/mastra/workspace-nono.js'

describe('Papyrus AgentFS workspace', () => {
  it('selects local AgentFS mount backends by operating system', () => {
    expect(agentFsMountBackend('linux')).toBe('fuse')
    expect(agentFsMountBackend('darwin')).toBe('nfs')
    expect(() => agentFsMountBackend('win32')).toThrow(/requires Linux or macOS/)
  })

  it('chains AgentFS mounting into a network-denied nono sandbox', () => {
    const filesystem = new PapyrusAgentFSFilesystem({
      dataDir: '/srv/papyrus',
      agentId: 'workspace',
      databasePath: '/srv/papyrus/.agentfs/workspace.db',
      binary: 'agentfs',
      platform: 'linux',
    })

    const plan = buildNonoLaunchPlan(filesystem, 'nono', 'python3 report.py', '/Library/Work')
    expect(plan.backend).toBe('fuse')
    expect(plan.binary).toBe('agentfs')
    expect(plan.args).toEqual(expect.arrayContaining([
      'exec',
      '--backend',
      'fuse',
      '/srv/papyrus/.agentfs/workspace.db',
      'nono',
      'run',
      '--allow-cwd',
      '--block-net',
    ]))
    expect(plan.args.join(' ')).toContain('python3 report.py')
    expect(plan.args.join(' ')).toContain('./Library/Work')
  })

  it('refuses sandbox working directories that escape the AgentFS root', () => {
    const filesystem = new PapyrusAgentFSFilesystem({
      dataDir: '/srv/papyrus',
      agentId: 'workspace',
      databasePath: '/srv/papyrus/.agentfs/workspace.db',
      platform: 'darwin',
    })
    expect(() => buildNonoLaunchPlan(filesystem, 'nono', 'pwd', '/../host')).toThrow(/escapes AgentFS workspace/)
  })

  it('does not pass Papyrus credentials into workspace child processes', () => {
    const env = minimalEnvironment('/srv/papyrus', {
      PAPYRUS_MODEL_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SAFE_FLAG: 'yes',
    })
    expect(env['PAPYRUS_MODEL_API_KEY']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['SAFE_FLAG']).toBe('yes')
  })
})
