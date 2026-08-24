import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { MastraServer as HonoMastraServer } from '@mastra/hono'
import { Memory } from '@mastra/memory'
import { AuthService } from '../auth.js'
import { ServerConfig } from '../config.js'
import { PapyrusDatabase } from '../db.js'
import { PapyrusMastraAuthProvider } from './auth-provider.js'
import { createMastraStorage } from './storage.js'
import { buildStaticAgentTools } from './tools.js'

export interface PapyrusMastraBundle {
  mastra: Mastra
  hono: Hono
}

// Wires the Mastra runtime, memory-backed agent, and Hono adapter together.
// The agent `papyrus` is the single AgentRuntime for every ACP session. The
// existing session lifecycle, authorization, audit, and MCP tool surface in
// PapyrusService stay intact — the Mastra instance only owns the model turn
// loop and its thread/memory storage.
export function createPapyrusMastra(config: ServerConfig, _db: PapyrusDatabase, auth: AuthService): PapyrusMastraBundle {
  const authProvider = new PapyrusMastraAuthProvider(auth)
  const storage = createMastraStorage(config.databasePath)

  const model = config.model
  const baseURL = model ? (model.endpoint.endsWith('/v1') ? model.endpoint : `${model.endpoint.replace(/\/$/, '')}/v1`) : 'https://api.openai.com/v1'
  const mastraModel = model
    ? createOpenAICompatible({
        name: 'papyrus-upstream',
        apiKey: model.apiKey ?? 'no-key',
        baseURL,
      }).chatModel(model.model)
    : createOpenAICompatible({ name: 'openai', apiKey: process.env.OPENAI_API_KEY ?? 'no-key', baseURL }).chatModel('gpt-4o-mini')

  const memory = new Memory({
    storage: storage as never,
    options: { lastMessages: 20, semanticRecall: false },
  })

  const papyrusAgent = new Agent({
    id: 'papyrus',
    name: 'papyrus',
    instructions: 'You are the Papyrus governed worker. Use the supplied tools to complete tasks. Built-in tools cover filesystem access, sandboxed code execution (Python/JS/TS), image generation, and user clarification. Never claim an action completed unless its tool result confirms it. If a tool throws an error, surface the error message verbatim to the user and propose an alternative — never fabricate a successful result.',
    model: mastraModel,
    tools: buildStaticAgentTools(),
    memory,
  })

  const mastra = new Mastra({
    storage,
    agents: { papyrus: papyrusAgent },
    server: { auth: authProvider },
  })

  const honoApp = new Hono()
  const server = new HonoMastraServer({ app: honoApp, mastra, prefix: '/api/agents' })
  void server.init()

  return { mastra, hono: (server as unknown as { app: Hono }).app }
}

export { MastraAgentWorker } from './worker.js'