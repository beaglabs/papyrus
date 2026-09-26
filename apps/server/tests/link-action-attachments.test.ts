import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActionStore } from '../src/agent/action-store.js'
import { AgentDatabase } from '../src/agent/database.js'
import { linkActionAttachments } from '../src/agent/link-action-attachments.js'
import { LINK_EXECUTOR_INTEGRATION_ID, LinkStore } from '../src/agent/link-store.js'
import { PapyrusAgentFSFilesystem } from '../src/agent/mastra/workspace-agentfs.js'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'papyrus-link-executors-'))
  const db = new AgentDatabase(':memory:')
  const actionStore = new ActionStore(db)
  const filesystem = new PapyrusAgentFSFilesystem({
    dataDir: root,
    agentId: 'link-executor-test',
    databasePath: join(root, 'agentfs.db'),
  })
  await filesystem.init()
  const links = new LinkStore(db, filesystem)
  links.ensureExecutorIntegration()
  await filesystem.writeFile('/Library/Generated/webhook.json', '{"type":"object"}')
  const draft = await links.prepareDraft({
    name: 'Build intake',
    type: 'webhook',
    sourcePath: '/Library/Generated/webhook.json',
    threadId: 'thread-build',
    resourceId: 'papyrus:test',
  })
  const link = await links.publishFromManifest(`/Library/Links/Drafts/${draft.draftId}/link.json`, 'operator-1')
  return {
    root, db, actionStore, filesystem, links, link,
    async close() {
      await filesystem.destroy()
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('Webhook Link Action Executor attachments', () => {
  it('persists the attachment and turns an inbound webhook into a durable approval proposal', async () => {
    const subject = await fixture()
    try {
      const store = linkActionAttachments(subject.db)
      const attachment = store.attach(subject.link, 'operator-1', {
        executorIntegrationId: LINK_EXECUTOR_INTEGRATION_ID,
        action: 'deploy.preview',
        target: 'repo:{{repository.id}}',
        invocationMode: 'always',
        approvalMode: 'required',
        inputMapping: {
          repository: 'repository.full_name',
          branch: 'ref',
        },
      })
      expect(store.list(subject.link.id)).toEqual([expect.objectContaining({
        id: attachment.id,
        executorIntegrationId: LINK_EXECUTOR_INTEGRATION_ID,
        action: 'deploy.preview',
        invocationMode: 'always',
        approvalMode: 'required',
      })])

      const inbound = subject.links.recordInbound({
        linkId: subject.link.id,
        blobPath: '/Library/Links/Inbound/test.json',
        method: 'POST',
        contentType: 'application/json',
        receivedAt: new Date().toISOString(),
        size: 100,
        sha256: 'a'.repeat(64),
      })
      const dispatches = store.dispatchWebhook(subject.actionStore, subject.link, inbound, {
        repository: { id: 42, full_name: 'beaglabs/papyrus' },
        ref: 'refs/heads/main',
      })

      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]?.proposal).toMatchObject({
        status: 'proposed',
        executorIntegrationId: LINK_EXECUTOR_INTEGRATION_ID,
        action: 'deploy.preview',
        target: 'repo:42',
        parameters: {
          repository: 'beaglabs/papyrus',
          branch: 'refs/heads/main',
        },
      })
      const proposal = dispatches[0]?.proposal
      expect(proposal).toBeDefined()
      expect(subject.actionStore.getInvestigation(proposal!.investigationId)?.status).toBe('awaiting_approval')
    } finally {
      await subject.close()
    }
  })

  it('does not propose conditional or agent-decides attachments until their trigger applies', async () => {
    const subject = await fixture()
    try {
      const store = linkActionAttachments(subject.db)
      store.attach(subject.link, 'operator-1', {
        executorIntegrationId: LINK_EXECUTOR_INTEGRATION_ID,
        action: 'incident.open',
        target: 'incident',
        invocationMode: 'conditional',
        condition: { path: 'severity', equals: 'high' },
      })
      store.attach(subject.link, 'operator-1', {
        executorIntegrationId: LINK_EXECUTOR_INTEGRATION_ID,
        action: 'agent.review',
        target: 'payload',
        invocationMode: 'agent_decides',
      })
      const inbound = subject.links.recordInbound({
        linkId: subject.link.id,
        blobPath: '/Library/Links/Inbound/test-conditional.json',
        method: 'POST',
        receivedAt: new Date().toISOString(),
        size: 50,
        sha256: 'b'.repeat(64),
      })

      const low = store.dispatchWebhook(subject.actionStore, subject.link, inbound, { severity: 'low' })
      expect(low.map((item) => item.skipped).sort()).toEqual(['agent_decides', 'condition_not_met'])
      expect(subject.actionStore.listProposals()).toHaveLength(0)

      const highInbound = subject.links.recordInbound({
        linkId: subject.link.id,
        blobPath: '/Library/Links/Inbound/test-high.json',
        method: 'POST',
        receivedAt: new Date().toISOString(),
        size: 50,
        sha256: 'c'.repeat(64),
      })
      const high = store.dispatchWebhook(subject.actionStore, subject.link, highInbound, { severity: 'high' })
      expect(high.filter((item) => item.proposal)).toHaveLength(1)
      expect(high.find((item) => item.attachment.invocationMode === 'agent_decides')?.skipped).toBe('agent_decides')
    } finally {
      await subject.close()
    }
  })
})
