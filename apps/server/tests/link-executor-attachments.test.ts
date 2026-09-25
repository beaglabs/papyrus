import { describe, expect, it } from 'vitest'
import {
  attachmentMatches,
  attachmentParameters,
  attachmentTarget,
  type WebhookExecutionContext,
  type WebhookExecutorAttachment,
} from '../src/agent/link-executor-attachments.js'

const context: WebhookExecutionContext = {
  body: {
    type: 'push',
    repository: { fullName: 'beaglabs/papyrus' },
    severity: 'high',
    attempts: 2,
  },
  link: { id: 'link-1', slug: 'github-build', name: 'GitHub build' },
  inbound: {
    id: 'inbound-1',
    blobPath: '/Library/Links/Inbound/link-1/inbound-1.json',
    method: 'POST',
    receivedAt: '2026-09-25T16:00:00.000Z',
  },
}

function attachment(overrides: Partial<WebhookExecutorAttachment> = {}): WebhookExecutorAttachment {
  return {
    id: 'attachment-1',
    linkId: 'link-1',
    executorIntegrationId: 'executor-1',
    executorName: 'Build executor',
    action: 'deploy_preview',
    target: '{body.repository.fullName}',
    enabled: true,
    invocationMode: 'agent_decides',
    inputMapping: {},
    approvalPolicy: 'inherit',
    createdByOid: 'owner',
    createdAt: '2026-09-25T15:00:00.000Z',
    updatedAt: '2026-09-25T15:00:00.000Z',
    ...overrides,
  }
}

describe('Webhook Action Executor attachment projections', () => {
  it('does not auto-propose agent_decides attachments', () => {
    expect(attachmentMatches(attachment(), context)).toBe(false)
  })

  it('auto-proposes always attachments and matching conditional attachments', () => {
    expect(attachmentMatches(attachment({ invocationMode: 'always' }), context)).toBe(true)
    expect(attachmentMatches(attachment({
      invocationMode: 'conditional',
      condition: { path: 'body.type', equals: 'push' },
    }), context)).toBe(true)
    expect(attachmentMatches(attachment({
      invocationMode: 'conditional',
      condition: { path: 'body.type', equals: 'pull_request' },
    }), context)).toBe(false)
  })

  it('supports existence conditions without treating falsey scalars as absent', () => {
    const falseyContext: WebhookExecutionContext = { ...context, body: { enabled: false, count: 0, empty: '' } }
    for (const path of ['body.enabled', 'body.count', 'body.empty']) {
      expect(attachmentMatches(attachment({
        invocationMode: 'conditional',
        condition: { path, exists: true },
      }), falseyContext)).toBe(true)
    }
  })

  it('maps inbound values while reserving Papyrus provenance and execution policy fields', () => {
    const parameters = attachmentParameters(attachment({
      inputMapping: {
        repository: 'body.repository.fullName',
        severity: 'body.severity',
        __papyrusWebhook: 'body.repository',
        __papyrusExecutionPolicy: 'body.repository',
      },
      approvalPolicy: 'required',
      timeoutMs: 30_000,
      maxRetries: 1,
    }), context)

    expect(parameters).toMatchObject({
      repository: 'beaglabs/papyrus',
      severity: 'high',
      __papyrusWebhook: {
        linkId: 'link-1',
        inboundId: 'inbound-1',
        method: 'POST',
      },
      __papyrusExecutionPolicy: {
        approval: 'required',
        timeoutMs: 30_000,
        maxRetries: 1,
      },
    })
  })

  it('interpolates target paths from the trusted webhook execution context', () => {
    expect(attachmentTarget(attachment({
      target: 'repo:{body.repository.fullName}:attempt:{body.attempts}',
    }), context)).toBe('repo:beaglabs/papyrus:attempt:2')
  })
})
