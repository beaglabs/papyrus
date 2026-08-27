import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalSandbox, createWorkspaceTools, WORKSPACE_TOOLS } from '@mastra/core/workspace'
import { PapyrusWorkspaceManager } from '../src/mastra/workspace.js'
import { detectCommandIsolation } from '../src/mastra/sandbox.js'

describe('Mastra session workspace', () => {
  const roots: string[] = []
  afterEach(() => { vi.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

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
    const secret = join(dataDir, 'outside.txt')
    writeFileSync(secret, 'private')
    symlinkSync(secret, join(dataDir, 'workspaces', sessionId, 'outside-link'))
    await expect(workspace.filesystem!.readFile('outside-link')).rejects.toThrow()
    await expect(workspace.filesystem!.readFile('../../outside.txt')).rejects.toThrow()
    await workspace.destroy()
  })

  it('never exposes an unisolated shell, host LSP, or browser CDP in local mode', async () => {
    vi.spyOn(LocalSandbox, 'detectIsolation').mockReturnValue({ available: false, backend: 'none', message: 'Unavailable' })
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-no-isolation-')); roots.push(dataDir)
    const manager = new PapyrusWorkspaceManager({ mode: 'local', dataDir } as never)
    const workspace = await manager.forSession('11111111-1111-4111-8111-111111111111')
    try {
      const tools = await createWorkspaceTools(workspace)
      expect(tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]).toBeUndefined()
      expect(tools[WORKSPACE_TOOLS.LSP.LSP_INSPECT]).toBeUndefined()
      expect(workspace.browser).toBeUndefined()
      // Contained file editing remains useful when commands are unavailable.
      await workspace.filesystem!.writeFile('result.txt', 'safe')
      expect(String(await workspace.filesystem!.readFile('result.txt'))).toBe('safe')
      expect(() => new PapyrusWorkspaceManager({ mode: 'persistent', dataDir } as never)).toThrow('isolation is required')
    } finally { await workspace.destroy() }
  })

  const isolation = detectCommandIsolation()
  it('has an OS sandbox when the native security CI job requires one', () => {
    if (process.env.PAPYRUS_REQUIRE_SANDBOX_TESTS === '1') expect(isolation.available, isolation.message).toBe(true)
  })

  it.skipIf(!isolation.available)('runs local work but blocks host reads, sibling sessions, writes, and all network access', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-native-security-')); roots.push(dataDir)
    const manager = new PapyrusWorkspaceManager({ mode: 'local', dataDir } as never)
    const id = '11111111-1111-4111-8111-111111111111'
    const workspace = await manager.forSession(id)
    const sibling = await manager.forSession('22222222-2222-4222-8222-222222222222')
    const secret = join(dataDir, 'host-secret.txt')
    writeFileSync(secret, 'host-secret')
    await sibling.filesystem!.writeFile('other.txt', 'sibling-secret')
    const calls = vi.fn()
    const server = createServer((_request, response) => { calls(); response.end('should not be reachable') })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const run = async (script: string) => workspace.sandbox!.executeCommand!(process.execPath, ['-e', script], { timeout: 3000 })
    try {
      // A denial test is meaningless if the runtime cannot execute at all.
      expect(await run('require("node:fs").writeFileSync("result.txt", "local-ok"); console.log("ran")')).toMatchObject({ exitCode: 0 })
      expect(String(await workspace.filesystem!.readFile('result.txt'))).toBe('local-ok')
      for (const target of [secret, join(dataDir, 'workspaces', '22222222-2222-4222-8222-222222222222', 'other.txt')]) {
        const result = await run(`require("node:fs").readFileSync(${JSON.stringify(target)}, "utf8")`)
        expect(result.exitCode).not.toBe(0)
      }
      symlinkSync(secret, join(dataDir, 'workspaces', id, 'linked-secret'))
      expect((await run('require("node:fs").readFileSync("linked-secret", "utf8")')).exitCode).not.toBe(0)
      await expect(workspace.filesystem!.readFile('linked-secret')).rejects.toThrow()
      expect((await run(`require("node:fs").writeFileSync(${JSON.stringify(secret)}, "changed")`)).exitCode).not.toBe(0)
      expect(readFileSync(secret, 'utf8')).toBe('host-secret')
      const network = await run(`fetch("http://127.0.0.1:${port}", {signal: AbortSignal.timeout(1000)}).then(() => process.exit(0), () => process.exit(9))`)
      expect(network.exitCode).toBe(9)
      expect(calls).not.toHaveBeenCalled()
      expect((await run('require("node:fs").writeFileSync("/dev/null", "ok")')).exitCode).toBe(0)
    } finally {
      server.close(); await once(server, 'close')
      await workspace.destroy(); await sibling.destroy()
    }
  }, 20_000)
})
