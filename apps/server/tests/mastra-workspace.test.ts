import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PapyrusWorkspaceManager } from '../src/mastra/workspace.js'

describe('Mastra session workspace', () => {
  const roots: string[] = []
  afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

  it('isolates sessions and materializes attachment bytes for search and tools', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-mastra-workspace-')); roots.push(dataDir)
    const manager = new PapyrusWorkspaceManager({ mode: 'local', dataDir, databasePath: join(dataDir, 'papyrus.db') } as never)
    const sessionId = '11111111-1111-4111-8111-111111111111'
    await manager.stagePrompt(sessionId, [{
      type: 'resource', resource: { uri: 'papyrus://attachments/policy.md', mimeType: 'text/markdown', text: '# Governed policy' },
    }])
    const workspace = await manager.forSession(sessionId)
    expect(String(await workspace.filesystem!.readFile('attachments/policy.md'))).toBe('# Governed policy')
    expect(String(await workspace.filesystem!.readFile('skills/papyrus-session/SKILL.md'))).toContain('Papyrus session workspace')
    await expect(manager.forSession('../../outside')).rejects.toThrow(/valid Papyrus session/)
    await workspace.destroy()
  })
})
