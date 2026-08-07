import type { NetworkProfile } from '../profiles/config.js'

/** The top-level node categories. */
export type NodeCategory =
  | 'discovery'
  | 'strategy'
  | 'design'
  | 'engineering'
  | 'ai-skill'
  | 'validation'
  | 'transition'
  | 'output'

/**
 * The role a node plays in the directed canvas flow. The flow is emergent from
 * edges, but `flowRole` lets the UI mark entry points, review gates, and exits.
 *
 *  - source : entry / input (typically Discovery inputs)
 *  - artifact : intermediate canvas node
 *  - skill : transformative AI Skill node (runs a Mastra agent)
 *  - review : human-in-the-loop gate (Mastra workflow suspend/resume)
 *  - exit : sink carrying downloadable deployment artifacts
 */
export type FlowRole = 'source' | 'artifact' | 'skill' | 'review' | 'exit'

export type FieldType =
  | 'text'
  | 'markdown'
  | 'longText'
  | 'list'
  | 'ref'
  | 'blob'
  | 'select'
  | 'json'
  | 'schema'

export interface FieldSpec {
  key: string
  label: string
  type: FieldType
  required?: boolean
  multi?: boolean
  options?: string[]
  /** For typed payloads, e.g. `openapi` on the API node, `stride` on Threat Model. */
  schemaRef?: string
  /** For `ref` fields: the node `type` this may point at. */
  refType?: string
}

export interface NodeTypeSpec {
  type: string
  category: NodeCategory
  flowRole: FlowRole
  icon: string
  title: string
  description: string
  fields: FieldSpec[]
  /** When true, creating/advancing this node triggers a Mastra HITL gate. */
  reviewable?: boolean
  /** For ai-skill nodes: the Mastra agent/workflow id to run. */
  skillId?: string
  /** For ai-skill nodes: artifact types this skill consumes as inputs. */
  consumes?: string[]
  /** For ai-skill nodes: artifact types this skill produces. */
  produces?: string[]
  /** Restrict to profiles; absent = all profiles. */
  profiles?: NetworkProfile[]
}

/**
 * The on-the-wire CRDT document for a canvas node. One generic schema for all
 * node types (keeps LWW merge + sneakernet export simple); the registry
 * validates/renders `fields` per `type`.
 */
export interface CanvasNodeDoc {
  id: string
  projectId: string
  type: string
  category: NodeCategory
  flowRole: FlowRole
  position: { x: number; y: number }
  fields: Record<string, unknown>
  status: string
  createdBy: string
  updatedAt: number
}

export interface EdgeDoc {
  id: string
  projectId: string
  from: string
  to: string
  kind: string
  createdBy: string
  updatedAt: number
}
