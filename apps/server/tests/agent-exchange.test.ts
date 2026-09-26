import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IntegrationConfiguration } from '@papyrus/contracts'
import { ExchangeEmailDriver } from '../src/agent/drivers/exchange-email-driver.js'
import { EmailExecutor } from '../src/agent/executors/email-executor.js'
import type { MicrosoftGraphClient } from '../src/agent/graph-client.js'
import { AgentDatabase } from '../src/agent/database.js'
import type { ActionExecutorContext } from '../src/agent/action-worker.js'
import { ActionExecutorRegistry, ActionWorker } from '../src/agent/action-worker.js'
import { ActionStore } from '../src/agent/action-store.js'
import { AgentService } from '../src/agent/service.js'
import { SyncWorker, ConnectorRegistry } from '../src/agent/sync-worker.js'
import { TerrainStore } from '../src/agent/terrain-store.js'
import { ArtifactStore } from '../src/agent/artifact-store.js'

const exchangeIntegration: IntegrationConfiguration = {
  id: 'exchange-1', catalogId: 'exchange-email', name: 'Operations mailbox',
  integrationClass: 'human_interface', authority: 'bidirectional', risk: 'moderate',
  state: 'active', scope: 'operations', credentialRef: 'vault://customer-vault/papyrus/exchange',
  settings: { mailbox: 'soc@example.mil' }, health: 'healthy',
  createdByOid: 'owner', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', version: 1,
}

function graph(overrides: Partial<MicrosoftGraphClient> = {}): MicrosoftGraphClient {
  return {
    async testMailbox() { return { mailbox: 'soc@example.mil', displayName: 'SOC Mailbox' } },
    async listMessages() { return { messages: [], hasMore: false } },
    async sendMail() { return { requestId: 'graph-request-1042' } },
    ...overrides,
  }
}

function executorContext(overrides: Partial<ActionExecutorContext['job']> = {}): ActionExecutorContext {
  return {
    config: {} as ActionExecutorContext['config'],
    signal: new AbortController().signal,
    proposal: {
      id: 'proposal-1', investigationId: 'investigation-1', proposedByOperatorId: 'owner', executorIntegrationId: exchangeIntegration.id,
      action: 'notify', target: 'analyst@example.mil', rationaleClaimIds: ['claim-1'], status: 'approved', requiredRole: 'Papyrus.Action.Approve',
      idempotencyKey: 'a'.repeat(64), proposedAt: '2026-09-02T00:00:00.000Z', approvedByOid: 'owner', approvedAt: '2026-09-02T00:00:00.000Z',
    },
    job: {
      id: 'job-1', proposalId: 'proposal-1', investigationId: 'investigation-1', executorIntegrationId: exchangeIntegration.id,
      action: 'notify', target: 'analyst@example.mil', idempotencyKey: 'a'.repeat(64), status: 'running', attempt: 1, maxAttempts: 3,
      createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', ...overrides,
    },
  }
}

describe('Exchange Graph connector boundary', () => {
  it('maps an incremental Graph mailbox page into compact HumanContext observations', async () => {
    const driver = new ExchangeEmailDriver(graph({
      async listMessages(_integration, cursor) {
        expect(cursor).toBe('https://graph.example/delta/previous')
        return {
          hasMore: false,
          nextCursor: 'https://graph.example/delta/final',
          messages: [{
            id: 'graph-message-1', internetMessageId: '<message-1@example.mil>', receivedDateTime: '2026-09-02T10:00:00.000Z',
            subject: 'Potential phishing report', importance: 'high', bodyPreview: 'This message may be suspicious.',
            from: { emailAddress: { address: 'reporter@example.mil', name: 'Reporter' } },
            toRecipients: [{ emailAddress: { address: 'soc@example.mil' } }], webLink: 'https://outlook.example/messages/1',
          }],
        }
      },
    }))

    const result = await driver.sync({ integration: exchangeIntegration, cursor: 'https://graph.example/delta/previous', signal: new AbortController().signal })
    expect(result.hasMore).toBe(false)
    expect(result.nextCursor).toBe('https://graph.example/delta/final')
    expect(result.observations).toEqual([expect.objectContaining({
      sourceRecordId: 'graph-message-1', evidenceType: 'HumanContext', subject: 'email:<message-1@example.mil>',
      payload: expect.objectContaining({ mailbox: 'soc@example.mil', bodyPreview: 'This message may be suspicious.' }),
    })])
  })

  it('tests the selected mailbox through Graph', async () => {
    const driver = new ExchangeEmailDriver(graph())
    await expect(driver.test({ integration: exchangeIntegration, signal: new AbortController().signal })).resolves.toMatchObject({
      reachable: true, authenticated: true, details: { mailbox: 'soc@example.mil' },
    })
  })

  it('sends only the specifically approved email action with its ledger key as client request id', async () => {
    const db = new AgentDatabase(':memory:')
    db.sqlite.prepare(`INSERT INTO agent_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      exchangeIntegration.id, exchangeIntegration.catalogId, exchangeIntegration.name, exchangeIntegration.integrationClass,
      exchangeIntegration.authority, exchangeIntegration.risk, exchangeIntegration.state, null, exchangeIntegration.scope,
      exchangeIntegration.credentialRef, JSON.stringify(exchangeIntegration.settings), exchangeIntegration.health,
      exchangeIntegration.createdByOid, exchangeIntegration.createdAt, exchangeIntegration.updatedAt, exchangeIntegration.version,
    )
    const sent: unknown[] = []
    const executor = new EmailExecutor(db, graph({
      async sendMail(_integration, input) { sent.push(input); return { requestId: 'graph-request-1042' } },
    }))

    const result = await executor.execute(executorContext({ parameters: { to: ['primary@example.mil', 'backup@example.mil'], subject: 'Containment update', body: 'Host isolated.' } }))
    expect(sent).toEqual([expect.objectContaining({
      mailbox: 'soc@example.mil', to: ['primary@example.mil', 'backup@example.mil'], subject: 'Containment update', body: 'Host isolated.', clientRequestId: 'a'.repeat(64),
    })])
    expect(result.message).toContain('graph-request-1042')
    db.close()
  })

  it('attaches durable artifacts only through the approved Exchange executor path', async () => {
    const db = new AgentDatabase(':memory:')
    db.sqlite.prepare(`INSERT INTO agent_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      exchangeIntegration.id, exchangeIntegration.catalogId, exchangeIntegration.name, exchangeIntegration.integrationClass,
      exchangeIntegration.authority, exchangeIntegration.risk, exchangeIntegration.state, null, exchangeIntegration.scope,
      exchangeIntegration.credentialRef, JSON.stringify(exchangeIntegration.settings), exchangeIntegration.health,
      exchangeIntegration.createdByOid, exchangeIntegration.createdAt, exchangeIntegration.updatedAt, exchangeIntegration.version,
    )

    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-email-artifact-'))
    try {
      const artifacts = new ArtifactStore(dataDir)
      const report = artifacts.create({ format: 'pdf', name: 'incident-report.pdf', content: 'Approved report.' })
      const sent: Array<Record<string, unknown>> = []
      const executor = new EmailExecutor(db, graph({
        async sendMail(_integration, input) { sent.push(input as unknown as Record<string, unknown>); return { requestId: 'with-attachment' } },
      }), artifacts)

      await executor.execute(executorContext({
        parameters: {
          subject: 'Incident report',
          body: 'Attached is the approved report.',
          artifactIds: [report.id],
        },
      }))

      const attachments = sent[0]?.['attachments'] as Array<Record<string, unknown>>
      expect(attachments).toHaveLength(1)
      expect(attachments[0]).toMatchObject({
        name: 'incident-report.pdf',
        contentType: 'application/pdf',
        contentBytes: readFileSync(artifacts.contentPath(report.id)).toString('base64'),
      })
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('permits an approved email proposal through an active Exchange integration', () => {
    const db = new AgentDatabase(':memory:')
    db.sqlite.prepare(`INSERT INTO agent_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      exchangeIntegration.id, exchangeIntegration.catalogId, exchangeIntegration.name, exchangeIntegration.integrationClass,
      exchangeIntegration.authority, exchangeIntegration.risk, exchangeIntegration.state, null, exchangeIntegration.scope,
      exchangeIntegration.credentialRef, JSON.stringify(exchangeIntegration.settings), exchangeIntegration.health,
      exchangeIntegration.createdByOid, exchangeIntegration.createdAt, exchangeIntegration.updatedAt, exchangeIntegration.version,
    )
    const config = { mode: 'local', profile: 'gcc', host: 'localhost', port: 3210, publicOrigin: 'http://localhost:3210', dataDir: '/tmp', databasePath: ':memory:', portalSecret: 'x'.repeat(32), organizationName: 'Example', cloud: 'Public', licenseRequired: false, licenseAuthorities: {} } as const
    const terrain = new TerrainStore(db)
    const actions = new ActionStore(db)
    const executors = new ActionExecutorRegistry().register('exchange-email', new EmailExecutor(db, graph()))
    const worker = new ActionWorker(db, actions, executors, config)
    const service = new AgentService(db, config, terrain, new SyncWorker(db, terrain, new ConnectorRegistry()), actions, executors, worker)
    const principal = { oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner'], groups: [], source: 'development' } as const
    const investigation = service.createInvestigation(principal, 'Email action', 'manual')

    expect(service.createProposal(principal, investigation.id, exchangeIntegration.id, 'notify', 'analyst@example.mil', ['claim-1'])).toMatchObject({
      executorIntegrationId: exchangeIntegration.id, action: 'notify', target: 'analyst@example.mil',
    })
    db.close()
  })

  it('rejects a malformed recipient before contacting Graph', async () => {
    const db = new AgentDatabase(':memory:')
    db.sqlite.prepare(`INSERT INTO agent_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      exchangeIntegration.id, exchangeIntegration.catalogId, exchangeIntegration.name, exchangeIntegration.integrationClass,
      exchangeIntegration.authority, exchangeIntegration.risk, exchangeIntegration.state, null, exchangeIntegration.scope,
      exchangeIntegration.credentialRef, JSON.stringify(exchangeIntegration.settings), exchangeIntegration.health,
      exchangeIntegration.createdByOid, exchangeIntegration.createdAt, exchangeIntegration.updatedAt, exchangeIntegration.version,
    )
    const executor = new EmailExecutor(db, graph())
    await expect(executor.execute(executorContext({ target: 'not-an-address' }))).rejects.toThrow(/valid recipient/)
    db.close()
  })
})
