import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PapyrusAgentFSFilesystem } from '../src/agent/mastra/workspace-agentfs.js'
import {
  NonoWorkspaceSandbox,
  normalizeWorkspaceCwd,
  workspaceEnvironment,
} from '../src/agent/mastra/workspace-nono.js'

describe('Papyrus SDK workspace', () => {
  it('reads and writes durable files through agentfs-sdk directly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'papyrus-agentfs-'))
    const filesystem = new PapyrusAgentFSFilesystem({
      dataDir: root,
      agentId: 'workspace',
      databasePath: join(root, '.agentfs', 'workspace.db'),
    })

    try {
      await filesystem.init()
      await filesystem.writeFile('/Library/report.txt', 'hello workspace')
      expect(await filesystem.readFile('/Library/report.txt', { encoding: 'utf8' })).toBe('hello workspace')
      expect(await filesystem.exists('/Library/report.txt')).toBe(true)
      expect((await filesystem.listLibrary('report')).map((file) => file.path)).toContain('/Library/report.txt')
      expect(filesystem.getInfo().metadata).toMatchObject({
        agentId: 'workspace',
        storage: 'local-sqlite',
        localOnly: true,
      })
    } finally {
      await filesystem.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports nono-ts kernel isolation without applying it to the daemon', () => {
    const filesystem = new PapyrusAgentFSFilesystem({
      dataDir: '/srv/papyrus',
      agentId: 'workspace',
      databasePath: '/srv/papyrus/.agentfs/workspace.db',
    })
    const sandbox = new NonoWorkspaceSandbox({
      filesystem,
      dataDir: '/srv/papyrus',
      platform: 'linux',
    })

    expect(sandbox.getInfo().metadata).toMatchObject({
      isolation: 'landlock-via-nono-ts',
      filesystem: 'agentfs-sdk',
      storage: 'local-sqlite',
      execution: 'materialize-sandbox-reconcile',
      network: 'blocked',
    })
  })

  it('refuses sandbox working directories that escape the AgentFS root', () => {
    expect(normalizeWorkspaceCwd('/Library/Work')).toBe('/Library/Work')
    expect(() => normalizeWorkspaceCwd('/../host')).toThrow(/escapes AgentFS workspace/)
  })

  it('does not pass Papyrus credentials into workspace child processes', () => {
    const env = workspaceEnvironment('/srv/papyrus/run', {
      PAPYRUS_MODEL_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SAFE_FLAG: 'yes',
    })
    expect(env['PAPYRUS_MODEL_API_KEY']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['SAFE_FLAG']).toBe('yes')
    expect(env['HOME']).toBe('/srv/papyrus/run/.papyrus-home')
  })
})
