import * as acp from '@agentclientprotocol/sdk'
import type { RuntimePromptRequest, RuntimePromptResult } from './index.js'

/**
 * Drives one ACP prompt turn over an already-authenticated transport.
 * Transport setup and teardown remain the caller's responsibility.
 */
export async function runAcpPrompt(
  stream: acp.Stream,
  request: RuntimePromptRequest,
): Promise<RuntimePromptResult> {
  const client = acp.client({ name: 'papyrus' })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      const allowed = await request.authorizeTool(params.toolCall.title ?? 'unknown-tool')
      const desired = allowed ? 'allow_once' : 'reject_once'
      const option = params.options.find((candidate) => candidate.kind === desired)
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    })

  return await client.connectWith(stream, async (context) => {
    // Papyrus does not grant a child direct client-side filesystem or terminal
    // capabilities. Governed execution is exposed through mediated MCP tools.
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    if (Array.isArray(request.prompt) && request.prompt.some((block) => block.type === 'resource') && !initialized.agentCapabilities?.promptCapabilities?.embeddedContext) {
      throw new Error('Runtime does not advertise ACP embedded-context support required for attachments')
    }

    const builder = context.buildSession({
      cwd: request.cwd,
      mcpServers: (request.mcpServers ?? []).map((server) => ({
        type: 'http' as const,
        name: server.name,
        url: server.url,
        headers: server.headers ?? [],
      })),
    })

    return await builder.withSession(async (session) => {
      await request.onEvent({
        kind: 'session',
        at: new Date().toISOString(),
        data: { runtimeSessionId: session.sessionId },
      })

      void session.prompt(request.prompt)
      for (;;) {
        const message = await session.nextUpdate()
        if (message.kind === 'stop') {
          await request.onEvent({
            kind: 'complete',
            at: new Date().toISOString(),
            data: message.response,
          })
          return {
            runtimeSessionId: session.sessionId,
            stopReason: message.stopReason,
          }
        }

        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: message.update,
        })
      }
    })
  })
}
