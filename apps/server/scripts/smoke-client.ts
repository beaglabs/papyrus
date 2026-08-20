import * as acp from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'

// Drives a minimal ACP client against the Papyrus gateway to smoke-test the
// full client → gateway → agent path. Configure:
//   PAPYRUS_SMOKE_URL      gateway ACP endpoint (e.g. http://127.0.0.1:3220/acp)
//   PAPYRUS_SMOKE_TOKEN    optional bearer token (gateway dev token on loopback)
//   PAPYRUS_SMOKE_WORKSPACE  workspace ID (required for X-Papyrus-Workspace-Id header)
//   PAPYRUS_SMOKE_PROMPT   optional prompt text
//   PAPYRUS_SMOKE_CWD      optional working directory for the session

const url = process.env.PAPYRUS_SMOKE_URL
const token = process.env.PAPYRUS_SMOKE_TOKEN
const workspaceId = process.env.PAPYRUS_SMOKE_WORKSPACE
const prompt = process.env.PAPYRUS_SMOKE_PROMPT ?? 'Reply with the single word: ok'
const cwd = process.env.PAPYRUS_SMOKE_CWD ?? process.cwd()

if (!url) {
  console.error('Set PAPYRUS_SMOKE_URL to the gateway ACP endpoint, e.g. http://127.0.0.1:3220/acp')
  process.exit(2)
}

const headers: Record<string, string> = {}
if (token) headers.authorization = `Bearer ${token}`
if (workspaceId) headers['x-papyrus-workspace-id'] = workspaceId

const stream = createHttpStream(url, { headers })

// The gateway answers tool-permission requests itself, so this handler is a
// fallback for agents that are not fronted by the gateway.
const client = acp.client({ name: 'papyrus-smoke' })
  .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
    const option = params.options.find((candidate) => candidate.kind === 'allow_once')
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
  })

async function main() {
  const result = await client.connectWith(stream, async (context) => {
    const init = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    console.log(`[smoke] agent ${init.agentInfo?.name} v${init.agentInfo?.version} protocol ${init.protocolVersion}`)
    const builder = context.buildSession({ cwd, mcpServers: [] })
    return builder.withSession(async (session) => {
      console.log(`[smoke] session ${session.sessionId}`)
      void session.prompt(prompt)
      let updates = 0
      for (;;) {
        const message = await session.nextUpdate()
        if (message.kind === 'stop') {
          console.log(`[smoke] stop reason=${message.stopReason}`)
          return { sessionId: session.sessionId, stopReason: message.stopReason, updates }
        }
        updates += 1
        console.log(`[smoke] update ${updates}: ${JSON.stringify(message.update).slice(0, 240)}`)
      }
    })
  })
  console.log(`[smoke] OK: ${JSON.stringify(result)}`)
}

main().catch((error) => {
  console.error('[smoke] FAILED:', error instanceof Error ? error.message : error)
  process.exit(1)
})
