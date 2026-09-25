import type { AgentConfig } from '../config.js'
import type { ActionStore } from '../action-store.js'
import type { AgentService } from '../service.js'
import type { TerrainStore } from '../terrain-store.js'
import { runWithSessionConnectorScope } from '../session-connector-access.js'
import { EnhancedMastraRuntime } from './enhanced-runtime.js'

/**
 * Adds the connector-capability boundary to the enhanced Mastra runtime.
 *
 * EnhancedMastraRuntime already binds the authenticated Entra actor to the chat
 * turn. This subclass mirrors that lifetime in a separate AsyncLocalStorage lane
 * consumed by low-level connector clients and executors, so a tool never trusts
 * model-supplied session identity.
 */
export class SessionScopedMastraRuntime extends EnhancedMastraRuntime {
  constructor(config: AgentConfig, actionStore: ActionStore, terrain: TerrainStore, service: AgentService) {
    super(config, actionStore, terrain, service)
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
