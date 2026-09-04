import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentDatabase } from '../src/agent/database.js'
import { ActionStore } from '../src/agent/action-store.js'
import type { AgentConfig } from '../src/agent/config.js'
import type { AgentService } from '../src/agent/service.js'
import type { TerrainStore } from '../src/agent/terrain-store.js'
import type { ArtifactRecord } from '../src/agent/artifact-store.js'
import { MastraRuntime } from '../src/agent/mastra/runtime.js'
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

  it('mirrors durable artifacts into AgentFS and repairs legacy missing mirrors by artifact name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'papyrus-artifact-link-'))
    const db = new AgentDatabase(':memory:')
    const actionStore = new ActionStore(db)
    const config: AgentConfig = {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 3210,
      publicOrigin: 'http://127.0.0.1:3210', dataDir: root, databasePath: ':memory:',
      portalSecret: 'test-secret', organizationName: 'Test', cloud: 'Public',
      agentfsId: 'artifact-link-test', licenseRequired: false, licenseAuthorities: {},
    }
    const runtime = new MastraRuntime(config, actionStore, {} as TerrainStore, {} as AgentService)
    await runtime.workspaceFilesystem.init()
    try {
      const artifact = runtime.artifacts.create({
        format: 'html', name: 'contractor-invite.html',
        content: '<!doctype html><title>Invite</title><p>Hello</p>',
      })
      const bridge = runtime as unknown as {
        artifactWithWorkspacePath(value: ArtifactRecord): Promise<ArtifactRecord & { workspacePath: string }>
        resolveLinkSource(sourcePath?: string, artifactId?: string): Promise<string>
      }
      const output = await bridge.artifactWithWorkspacePath(artifact)
      expect(output.workspacePath).toBe('/Library/Generated/contractor-invite.html')
      expect((await runtime.workspaceFilesystem.describeLibraryFile(output.workspacePath)).sha256).toBe(artifact.sha256)
      await runtime.workspaceFilesystem.deleteFile(output.workspacePath)
      const repaired = await bridge.resolveLinkSource('/Library/Generated/contractor-invite.html')
      expect(repaired).toBe('/Library/Generated/contractor-invite.html')
      expect((await runtime.workspaceFilesystem.describeLibraryFile(repaired)).sha256).toBe(artifact.sha256)
      await runtime.workspaceFilesystem.deleteFile(repaired)
      const byId = await bridge.resolveLinkSource(undefined, artifact.id)
      expect(byId).toBe('/Library/Generated/contractor-invite.html')
      expect((await runtime.workspaceFilesystem.describeLibraryFile(byId)).sha256).toBe(artifact.sha256)
    } finally {
      await runtime.workspaceFilesystem.destroy()
      db.close()
      rmSync(root, { recursive: true, force: true })
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
