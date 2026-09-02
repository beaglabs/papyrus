import type { CyberActionProposal, CyberInvestigation, TerrainSnapshot } from '@papyrus/contracts'
import type { ActionStore } from '../action-store.js'
import type { TerrainStore } from '../terrain-store.js'

/**
 * Investigation tools exposed to the agent harness.
 *
 * Every tool here is read-only. Approve and deny are deliberately absent: the
 * action ledger owns authorization, so a tool that could release an action
 * would let the agent approve its own proposal. A human approves through the
 * portal or an adapter using their own Entra session, and the ledger re-checks
 * the Papyrus.Action.Approve role server-side.
 *
 * These are plain functions rather than Mastra `createTool` definitions so
 * they remain unit-testable without the Mastra packages installed. The Mastra
 * adapter wraps them at the boundary.
 */

export interface InvestigationToolContext {
  actionStore: ActionStore
  terrain: TerrainStore
}

export interface ToolDescriptor {
  name: string
  description: string
  authority: 'read_only'
}

export const INVESTIGATION_TOOLS = {
  terrainQuery: {
    name: 'terrainQuery',
    description: 'Return the current cyber terrain: observed entities, relationships, observation count, and unresolved claims.',
    authority: 'read_only',
  },
  listInvestigations: {
    name: 'listInvestigations',
    description: 'List investigations with their status, claims, and linked proposals.',
    authority: 'read_only',
  },
  listProposals: {
    name: 'listProposals',
    description: 'List action proposals, optionally filtered to one investigation. Proposals are pending until a human approves them.',
    authority: 'read_only',
  },
} as const satisfies Record<string, ToolDescriptor>

export type InvestigationToolName = keyof typeof INVESTIGATION_TOOLS

/**
 * Tool names that must never be registered on an agent. Present so a future
 * change fails loudly instead of quietly granting the agent an approval path.
 */
export const FORBIDDEN_AGENT_TOOLS = ['approveProposal', 'denyProposal', 'executeAction'] as const

export class AgentToolAuthorizationError extends Error {
  constructor(name: string) {
    super(`Tool ${name} would let the agent authorize or execute an action; it must stay a human action against the ledger`)
    this.name = 'AgentToolAuthorizationError'
  }
}

export function assertAgentSafeTool(name: string): void {
  if ((FORBIDDEN_AGENT_TOOLS as readonly string[]).includes(name)) throw new AgentToolAuthorizationError(name)
}

export function isInvestigationTool(name: string): name is InvestigationToolName {
  return Object.prototype.hasOwnProperty.call(INVESTIGATION_TOOLS, name)
}

export function terrainQuery(context: InvestigationToolContext): TerrainSnapshot {
  return context.terrain.snapshot()
}

export function listInvestigations(context: InvestigationToolContext): CyberInvestigation[] {
  return context.actionStore.listInvestigations()
}

export interface ListProposalsArgs {
  investigationId?: string | undefined
}

export function listProposals(context: InvestigationToolContext, args: ListProposalsArgs = {}): CyberActionProposal[] {
  const investigationId = typeof args.investigationId === 'string' && args.investigationId.length > 0
    ? args.investigationId
    : undefined
  return investigationId
    ? context.actionStore.listProposals(investigationId)
    : context.actionStore.listProposals()
}

export type InvestigationToolResult = TerrainSnapshot | CyberInvestigation[] | CyberActionProposal[]

/** Dispatch by tool name. Returns undefined for unknown tools rather than guessing. */
export function runInvestigationTool(
  name: InvestigationToolName,
  context: InvestigationToolContext,
  args: Record<string, unknown> = {},
): InvestigationToolResult {
  assertAgentSafeTool(name)
  switch (name) {
    case 'terrainQuery':
      return terrainQuery(context)
    case 'listInvestigations':
      return listInvestigations(context)
    case 'listProposals':
      return listProposals(context, { investigationId: optionalString(args['investigationId']) })
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
