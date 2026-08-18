import { describe, expect, it } from 'vitest'
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { GatewayRelay } from '../src/gateway.js'
import { testContext } from './helpers.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function channel() {
  let enqueue: (message: AnyMessage) => void = () => {}
  let close = () => {}
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      enqueue = (message) => controller.enqueue(message)
      close = () => controller.close()
    },
  })
  return { readable, enqueue: (message: AnyMessage) => enqueue(message), close: () => close() }
}

function sink() {
  const written: AnyMessage[] = []
  const writable = new WritableStream<AnyMessage>({ write: (message) => { written.push(message) } })
  return { writable, written }
}

function setup() {
  const context = testContext()
  const owner = context.db.upsertUser({ externalId: 'dev:owner', displayName: 'Owner', authMethod: 'development' })
  context.db.setRole(owner.id, 'Owner')
  const activeOwner = context.db.getPrincipal(owner.id)!
  const user = context.db.upsertUser({ externalId: 'dev:user', displayName: 'User', authMethod: 'development' })
  context.db.setRole(user.id, 'User')
  const activeUser = context.db.getPrincipal(user.id)!
  const workspace = context.service.createWorkspace(activeOwner, { name: 'Mission', description: '' })
  const runtime = context.service.createRuntime(activeOwner, { name: 'Goose', mode: 'child-process', model: { provider: 'openai-compatible', baseUrl: 'http://model/v1', model: 'm', secretRef: 'primary' } })
  context.service.assign(activeOwner, activeUser.id, 'workspace', workspace.id)
  context.service.assign(activeOwner, activeUser.id, 'runtime', runtime.id)
  const client = channel(); const clientSink = sink()
  const goose = channel(); const gooseSink = sink()
  const clientStream: Stream = { readable: client.readable, writable: clientSink.writable }
  const gooseStream: Stream = { readable: goose.readable, writable: gooseSink.writable }
  return { context, user: activeUser, workspace, runtime, client, clientSink, goose, gooseSink, clientStream, gooseStream }
}

describe('ACP gateway relay', () => {
  it('authorizes session/new, rewrites MCP servers, and maps the goose session', async () => {
    const ctx = setup()
    try {
      const relay = new GatewayRelay(ctx.context.service, { principal: ctx.user, workspace: ctx.workspace, runtime: ctx.runtime }, ctx.clientStream, ctx.gooseStream)
      void relay.run()

      ctx.client.enqueue({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [{ type: 'http', name: 'evil', url: 'http://evil.internal' }] } })
      await flush()
      const forwarded = ctx.gooseSink.written[0] as { params: { mcpServers: Array<{ url: string }> } }
      expect(forwarded.params.mcpServers).toHaveLength(0)
      expect(forwarded.params.mcpServers.some((server) => server.url.includes('evil'))).toBe(false)

      ctx.goose.enqueue({ jsonrpc: '2.0', id: 1, result: { sessionId: 'goose-session-1' } })
      await flush()
      expect(ctx.clientSink.written).toHaveLength(1)
      expect(ctx.context.service.listSessions(ctx.user)).toHaveLength(1)
      expect(ctx.context.service.audit.verify()).toEqual({ valid: true })

      // prompt against the mapped session is authorized and forwarded
      ctx.client.enqueue({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'goose-session-1', prompt: [{ type: 'text', text: 'hi' }] } })
      await flush()
      expect(ctx.gooseSink.written.some((message) => (message as { id?: unknown }).id === 2)).toBe(true)
    } finally { ctx.context.dispose() }
  })

  it('denies an unauthorized prompt and an ungranted tool call', async () => {
    const ctx = setup()
    try {
      const relay = new GatewayRelay(ctx.context.service, { principal: ctx.user, workspace: ctx.workspace, runtime: ctx.runtime }, ctx.clientStream, ctx.gooseStream)
      void relay.run()

      // prompt with an unknown goose session -> local error, not forwarded
      ctx.client.enqueue({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'missing', prompt: [{ type: 'text', text: 'hi' }] } })
      await flush()
      expect(ctx.gooseSink.written).toHaveLength(0)
      const error = ctx.clientSink.written[0] as { error?: { message?: string } }
      expect(error.error?.message).toMatch(/Unknown session/)

      // establish a session so a permission request can be mapped
      ctx.client.enqueue({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } })
      await flush()
      ctx.goose.enqueue({ jsonrpc: '2.0', id: 2, result: { sessionId: 'goose-session-2' } })
      await flush()

      // goose requests permission for an ungranted tool -> rejected directly, not forwarded
      const before = ctx.clientSink.written.length
      ctx.goose.enqueue({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: { sessionId: 'goose-session-2', toolCall: { title: 'ungranted_tool' }, options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'reject' }] } })
      await flush()
      const response = ctx.gooseSink.written.find((message) => (message as { id?: unknown }).id === 3) as { result?: { outcome?: { outcome?: string; optionId?: string } } }
      expect(response?.result?.outcome?.outcome).toBe('selected')
      expect(response?.result?.outcome?.optionId).toBe('reject')
      expect(ctx.clientSink.written.length).toBe(before)
    } finally { ctx.context.dispose() }
  })
})
