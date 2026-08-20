#!/usr/bin/env node
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

if (process.argv.includes('--version')) {
  process.stdout.write('papyrus-acp-fixture 1.0.0\n')
  process.exit(0)
}

const mode = process.env.PAPYRUS_STDIO_FIXTURE_MODE ?? 'complete'
const sessions = new Map()

const agent = acp.agent({ name: 'papyrus-stdio-fixture' })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    const sessionId = 'fixture-session'
    sessions.set(sessionId, { cancelled: false })
    return { sessionId }
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (!sessions.has(ctx.params.sessionId)) throw new Error('unknown fixture session')
    if (mode === 'crash') {
      process.stderr.write('fixture crash\n')
      process.exit(17)
    }
    if (mode === 'hang') {
      await new Promise(() => {})
    }

    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'fixture response' },
      },
    })
    return { stopReason: 'end_turn' }
  })
  .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId)
    if (session) session.cancelled = true
  })

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
)

process.stderr.write('fixture ready\n')
agent.connect(stream)
