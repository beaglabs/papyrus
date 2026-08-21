import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AgentRuntime } from '@papyrus/acp-runtime'
import type { Approval } from '@papyrus/contracts'
import { describe, expect, it } from 'vitest'
import { createPapyrusServer } from '../src/http.js'
import { testContext } from './helpers.js'

function approvalRuntime(): AgentRuntime {
  return {
    kind: 'test',
    capabilities: { transports: ['stdio'], sessions: { cancel: true, load: false, resume: false, fork: false } },
    health: async () => ({ available: true }),
    runPrompt: async (request) => {
      const approved = await request.authorizeTool('records.search')
      await request.onEvent({
        kind: 'update', at: new Date().toISOString(),
        data: { sessionUpdate: 'tool_call_update', toolCallId: 'approval-tool', title: 'records.search', status: approved ? 'completed' : 'failed' },
      })
      return { runtimeSessionId: 'approval-runtime', stopReason: 'end_turn' }
    },
  }
}

async function waitForPending(request: (path: string, init?: RequestInit) => Promise<Response>, sessionId: string): Promise<Approval> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(`/api/sessions/${sessionId}/approvals`)
    const pending = (await response.json() as { approvals: Approval[] }).approvals.find((approval) => approval.status === 'pending')
    if (pending) return pending
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Approval did not become pending')
}

describe('durable human approval HTTP API', () => {
  it('pauses a granted tool call until an authorized one-time decision is recorded', async () => {
    const ctx = testContext(() => approvalRuntime())
    const owner = ctx.db.upsertUser({ externalId: 'oidc:approval-owner', displayName: 'Owner', authMethod: 'oidc' })
    ctx.db.setRole(owner.id, 'Owner')
    const activeOwner = ctx.db.getPrincipal(owner.id)!
    const user = ctx.db.upsertUser({ externalId: 'oidc:approval-user', displayName: 'User', authMethod: 'oidc' })
    ctx.db.setRole(user.id, 'User')
    const activeUser = ctx.db.getPrincipal(user.id)!
    const environment = ctx.service.createEnvironment(activeOwner, { name: 'Approvals', description: '' })
    ctx.service.assign(activeOwner, activeUser.id, environment.id)
    const mcp = ctx.service.addMcpServer(activeOwner, { name: 'Records', endpoint: 'http://127.0.0.1:9999' })
    ctx.service.grantMcpServer(activeOwner, environment.id, mcp.id)
    const session = ctx.service.createSession(activeUser, environment.id, 'goose', 'Approval review')
    const authorization = `Bearer ${ctx.auth.issueSession(activeUser.id)}`
    const server = createPapyrusServer(ctx.config, ctx.service, ctx.auth)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
      ...init, headers: { authorization, 'content-type': 'application/json', ...init.headers },
    })

    try {
      const prompt = request(`/api/sessions/${session.id}/prompts`, { method: 'POST', body: JSON.stringify({ prompt: 'Search records' }) })
      const pending = await waitForPending(request, session.id)
      expect(pending).toMatchObject({ sessionId: session.id, requesterId: activeUser.id, toolTitle: 'records.search', status: 'pending' })

      const decision = await request(`/api/sessions/${session.id}/approvals/${pending.id}/decision`, {
        method: 'POST', body: JSON.stringify({ decision: 'approved', reason: 'Mission need verified' }),
      })
      expect(decision.status).toBe(200)
      expect(await decision.json()).toMatchObject({ status: 'approved', decidedBy: activeUser.id, reason: 'Mission need verified' })
      expect((await prompt).status).toBe(200)

      const repeated = await request(`/api/sessions/${session.id}/approvals/${pending.id}/decision`, {
        method: 'POST', body: JSON.stringify({ decision: 'denied' }),
      })
      expect(repeated.status).toBe(409)
      expect(await repeated.json()).toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' })

      const approvals = await request(`/api/sessions/${session.id}/approvals`)
      expect((await approvals.json() as { approvals: Approval[] }).approvals[0]).toMatchObject({ id: pending.id, status: 'approved' })
      expect(ctx.service.sessionEvents(activeUser, session.id).filter((event) => event.kind === 'approval').map((event) => (event.data as Approval).status)).toEqual(['pending', 'approved'])
    } finally {
      server.close()
      await once(server, 'close')
      ctx.dispose()
    }
  })
})
