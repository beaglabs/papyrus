import { createCodeMode } from '@mastra/core/tools'
import type { AgentConfig } from '../config.js'
import type { ActionStore } from '../action-store.js'
import type { AgentService } from '../service.js'
import type { TerrainStore } from '../terrain-store.js'
import { buildAppFactoryTools } from '../apps/agent-tools.js'
import { runWithSessionConnectorScope } from '../session-connector-access.js'
import { EnhancedMastraRuntime } from './enhanced-runtime.js'

/**
 * Adds the connector-capability boundary and the conversational App Link factory
 * to the enhanced Mastra runtime.
 *
 * App authoring intentionally extends the same tool construction used by the
 * supervisor instead of standing up a second "Apps" control plane. The agent
 * receives the ordinary governed app lifecycle tools plus one Mastra Code Mode
 * tool that can compose those operations with the read-only connector tools
 * available to this runtime. Host-side connector calls still execute inside the
 * session AsyncLocalStorage boundary below; Code Mode receives no ambient
 * credentials or direct network access.
 */
export class SessionScopedMastraRuntime extends EnhancedMastraRuntime {
  constructor(config: AgentConfig, actionStore: ActionStore, terrain: TerrainStore, service: AgentService) {
    super(config, actionStore, terrain, service)

    // EnhancedMastraRuntime builds its final supervisor after MastraRuntime has
    // started. Extend that existing build hook so memory, goal judging,
    // delegation, connector processors, and policy processors remain exactly the
    // same agent rather than creating a parallel app-specific agent.
    const runtime = this as unknown as {
      buildTools: (createTool: (options: unknown) => unknown) => Record<string, unknown>
    }
    const baseBuildTools = runtime.buildTools.bind(this)
    runtime.buildTools = (createTool) => {
      const tools = baseBuildTools(createTool)
      const appFactory = buildAppFactoryTools(createTool, {
        db: this.actionStore.db,
        filesystem: this.workspaceFilesystem,
        dataDir: this.config.dataDir,
        connectorToolNames: () => [...this.appConnectorTools.keys()],
        currentScope: (context) => {
          const actor = this.currentActor()
          const threadId = requestContextValue(context, 'papyrusThreadId')
          if (!actor || !threadId) throw new Error('App Link authoring requires an authenticated Papyrus session')
          return { actor, threadId }
        },
      })

      const codeModeTools: Record<string, unknown> = { ...appFactory.tools }
      for (const name of this.appConnectorTools.keys()) {
        if (tools[name]) codeModeTools[name] = tools[name]
      }

      const codeMode = createCodeMode({
        id: 'app_factory_code',
        tools: codeModeTools as never,
        sandbox: this.workspaceSandbox,
      })
      const codeTool = codeMode.tool as unknown as { description?: string }
      codeTool.description = [
        codeTool.description,
        'Use this for multi-step App Link software-factory work: gather data from the connectors attached to this session, transform it, author the app source, and build a preview without round-tripping every intermediate result through model context.',
        appFactory.instructions,
        codeMode.instructions,
      ].filter(Boolean).join('\n\n')

      Object.assign(tools, appFactory.tools, { app_factory_code: codeMode.tool })
      return tools
    }
  }

  override async chat(threadId: string, params: Record<string, unknown>): Promise<Response> {
    const actor = this.currentActor()
    if (!actor) return super.chat(threadId, params)
    return runWithSessionConnectorScope(
      this.actionStore.db,
      { sessionId: threadId, actorOid: actor.oid },
      () => super.chat(threadId, params),
    )
  }
}

function requestContextValue(context: Record<string, unknown> | undefined, key: string): string | undefined {
  const requestContext = context?.['requestContext']
  if (!requestContext || typeof requestContext !== 'object') return undefined
  const getter = (requestContext as Record<string, unknown>)['get']
  const value = typeof getter === 'function'
    ? (getter as (name: string) => unknown).call(requestContext, key)
    : (requestContext as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
