import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { Memory } from '@mastra/memory'
import { ServerConfig } from '../config.js'
import { PapyrusDatabase } from '../db.js'
import { fastembed } from '@mastra/fastembed'
import { LibSQLVector } from '@mastra/libsql'
import { createMastraStorage } from './storage.js'
import { buildStaticAgentTools } from './tools.js'
import { PapyrusWorkspaceManager } from './workspace.js'
import { wrapModelForCloudflare } from './cloudflare-model.js'

export interface PapyrusMastraBundle {
  mastra: Mastra
  workspaces: PapyrusWorkspaceManager
}

// Wires the Mastra runtime, memory-backed agent, and Hono adapter together.
// The agent `papyrus` is the single AgentRuntime for every ACP session. The
// existing session lifecycle, authorization, audit, and MCP tool surface in
// PapyrusService stay intact — the Mastra instance only owns the model turn
// loop and its thread/memory storage.
export function createPapyrusMastra(config: ServerConfig, _db: PapyrusDatabase): PapyrusMastraBundle {
  const storage = createMastraStorage(config.databasePath)

  const model = config.model
  const baseURL = model ? (model.endpoint.endsWith('/v1') ? model.endpoint : `${model.endpoint.replace(/\/$/, '')}/v1`) : 'https://api.openai.com/v1'
  let mastraModel = model
    ? createOpenAICompatible({
        name: 'papyrus-upstream',
        apiKey: model.apiKey ?? 'no-key',
        baseURL,
      }).chatModel(model.model)
    : createOpenAICompatible({ name: 'openai', apiKey: process.env.OPENAI_API_KEY ?? 'no-key', baseURL }).chatModel('gpt-4o-mini')

  // Normalize every provider call to a single leading system message for
  // Workers AI models such as Qwen, including memory/workspace instructions.
  if (model?.endpoint?.includes('cloudflare.com')) {
    mastraModel = wrapModelForCloudflare(mastraModel)
  }

  const memory = new Memory({
    storage: storage as never,
    vector: new LibSQLVector({ id: 'papyrus-memory-vector', url: `file:${config.databasePath}` }),
    embedder: fastembed,
    options: {
      lastMessages: 30,
      semanticRecall: { topK: 5, messageRange: { before: 2, after: 1 }, scope: 'resource' },
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: '# Papyrus working memory\n\n## User preferences\n\n## Decisions and constraints\n\n## Active work\n\n## Useful facts',
      },
    },
  })
  const workspaces = new PapyrusWorkspaceManager(config)

  const papyrusAgent = new Agent({
    id: 'papyrus',
    name: 'papyrus',
    instructions: 'You are the Papyrus governed worker. Use the supplied tools to complete tasks. Prefer dedicated tools over shell commands: use papyrus_create_pdf for PDF generation/export and papyrus_generate for image generation. Start broad requests immediately using reasonable, reversible defaults; for example, a request to create a PDF should call papyrus_create_pdf immediately and does not require elicitation or environment inspection. Filesystem and sandboxed command tools may be available per session, but never repeatedly probe or retry an unchanged failed command. After one failed attempt, change approach or report the exact failure. Call papyrus_request_input only when one or more specific field-level values are genuinely required and work cannot continue without them. Never use elicitation to ask what the user wants in general, to collect optional preferences, to confirm capability, or to defer making a reasonable implementation choice. Never claim an action completed unless its tool result confirms it. If a tool throws an error, surface the error message verbatim to the user and propose an alternative — never fabricate a successful result.',
    model: mastraModel,
    tools: buildStaticAgentTools({ nativeBrowserEnabled: config.nativeBrowserEnabled }),
    memory,
    workspace: async ({ requestContext }) => {
      const sessionId = requestContext.get('sessionId')
      return typeof sessionId === 'string' ? await workspaces.forSession(sessionId) : undefined
    },
    goal: { judge: mastraModel, maxRuns: 12 },
  })

  const mastra = new Mastra({
    storage,
    agents: { papyrus: papyrusAgent },
  })
  return { mastra, workspaces }
}

export { MastraAgentWorker } from './worker.js'
