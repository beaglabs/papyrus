import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentDatabase } from '../src/agent/database.js'
import { LINK_EXECUTOR_INTEGRATION_ID, LinkStore } from '../src/agent/link-store.js'
import { PapyrusAgentFSFilesystem } from '../src/agent/mastra/workspace-agentfs.js'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'papyrus-links-'))
  const db = new AgentDatabase(':memory:')
  const filesystem = new PapyrusAgentFSFilesystem({
    dataDir: root,
    agentId: 'links-test',
    databasePath: join(root, 'agentfs.db'),
  })
  await filesystem.init()
  const links = new LinkStore(db, filesystem)
  return {
    root,
    db,
    filesystem,
    links,
    async close() {
      await filesystem.destroy()
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('AgentFS Links boundary', () => {
  it('provisions the built-in controlled-action executor without exposing content', async () => {
    const subject = await fixture()
    try {
      const integration = subject.links.ensureExecutorIntegration()
      expect(integration.id).toBe(LINK_EXECUTOR_INTEGRATION_ID)
      expect(integration.catalogId).toBe('papyrus-links')
      expect(integration.state).toBe('active')
      expect(integration.authority).toBe('controlled_actions')
      expect(subject.links.list()).toEqual([])
    } finally {
      await subject.close()
    }
  })

  it('snapshots approved AgentFS bytes before publication', async () => {
    const subject = await fixture()
    try {
      await subject.filesystem.writeFile('/Library/Generated/demo.html', '<!doctype html><title>Demo</title><h1>Hello</h1>')
      const draft = await subject.links.prepareDraft({
        name: 'Demo page',
        type: 'webpage',
        sourcePath: '/Library/Generated/demo.html',
      })

      expect(draft.sourcePath).toMatch(/^\/Library\/Links\/Drafts\//)
      const live = await subject.links.publishFromManifest(
        `/Library/Links/Drafts/${draft.draftId}/link.json`,
        'operator-1',
      )
      expect(live).toMatchObject({
        id: draft.draftId,
        name: 'Demo page',
        type: 'webpage',
        state: 'live',
        publicPath: '/l/demo-page',
        sourceSha256: draft.sourceSha256,
      })
      expect(live.blobPath).toMatch(/^\/Library\/Links\/Published\//)
      expect(await subject.filesystem.readFile(live.blobPath, { encoding: 'utf8' })).toContain('<h1>Hello</h1>')
    } finally {
      await subject.close()
    }
  })

  it('refuses publication if the snapshotted draft changes after review', async () => {
    const subject = await fixture()
    try {
      await subject.filesystem.writeFile('/Library/Generated/api.json', '{"ok":true}')
      const draft = await subject.links.prepareDraft({
        name: 'Status API',
        type: 'api',
        sourcePath: '/Library/Generated/api.json',
      })
      await subject.filesystem.writeFile(draft.sourcePath, '{"ok":false}', { overwrite: true })
      await expect(subject.links.publishFromManifest(
        `/Library/Links/Drafts/${draft.draftId}/link.json`,
        'operator-1',
      )).rejects.toThrow(/changed after the operator reviewed/)
    } finally {
      await subject.close()
    }
  })
})
