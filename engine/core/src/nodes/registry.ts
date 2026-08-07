import type { NetworkProfile } from '../profiles/config.js'
import { ALL_NODE_TYPES } from './catalog/index.js'
import type { CanvasNodeDoc, FieldSpec, NodeTypeSpec } from './types.js'

export type { NetworkProfile }

const REGISTRY: ReadonlyMap<string, NodeTypeSpec> = new Map(
  ALL_NODE_TYPES.map((spec) => [spec.type, spec] as const),
)

export function getNodeType(type: string): NodeTypeSpec | undefined {
  return REGISTRY.get(type)
}

export function listNodeTypes(category?: NodeTypeSpec['category']): NodeTypeSpec[] {
  const all = [...REGISTRY.values()]
  return category ? all.filter((n) => n.category === category) : all
}

/** Filter the catalog by the active network profile (for the canvas palette). */
export function nodeTypesForProfile(profile: NetworkProfile): NodeTypeSpec[] {
  return [...REGISTRY.values()].filter((n) => !n.profiles || n.profiles.includes(profile))
}

export function isReviewable(type: string): boolean {
  return getNodeType(type)?.reviewable === true
}

export function validateFields(type: string, fields: Record<string, unknown>): string[] {
  const spec = getNodeType(type)
  if (!spec) return [`unknown node type: ${type}`]
  const errors: string[] = []
  for (const f of spec.fields) {
    const present = fields[f.key] !== undefined && fields[f.key] !== null
    if (f.required && !present) errors.push(`missing required field: ${f.key}`)
    if (present) validateFieldType(f, fields[f.key], errors)
  }
  return errors
}

function validateFieldType(f: FieldSpec, value: unknown, errors: string[]): void {
  const isList = ['list', 'ref', 'blob'].includes(f.type) && f.multi
  if (f.type === 'select' && f.options && typeof value === 'string' && !f.options.includes(value)) {
    errors.push(`${f.key}: "${value}" is not one of ${f.options.join(', ')}`)
  }
  if (isList && !Array.isArray(value)) {
    errors.push(`${f.key}: expected an array (multi)`)
  }
}

/** Build a new CanvasNodeDoc with sane defaults; content validated against registry. */
export function newNode(opts: {
  id: string
  projectId: string
  type: string
  position: { x: number; y: number }
  createdBy: string
  fields?: Record<string, unknown>
}): CanvasNodeDoc | { errors: string[] } {
  const spec = getNodeType(opts.type)
  if (!spec) return { errors: [`unknown node type: ${opts.type}`] }
  const fields = opts.fields ?? {}
  const errors = validateFields(opts.type, fields)
  if (errors.length) return { errors }
  return {
    id: opts.id,
    projectId: opts.projectId,
    type: opts.type,
    category: spec.category,
    flowRole: spec.flowRole,
    position: opts.position,
    fields,
    status: 'draft',
    createdBy: opts.createdBy,
    updatedAt: Date.now(),
  }
}
