import type { NodeTypeSpec } from '../types.js'
import { AI_SKILL_NODES } from './ai-skill.js'
import { DESIGN_NODES } from './design.js'
import { DISCOVERY_NODES } from './discovery.js'
import { ENGINEERING_NODES } from './engineering.js'
import { OUTPUT_NODES } from './output.js'
import { STRATEGY_NODES } from './strategy.js'
import { TRANSITION_NODES } from './transition.js'
import { VALIDATION_NODES } from './validation.js'

/** The full shipped node catalog. Validated/rendered by the registry. */
export const ALL_NODE_TYPES: NodeTypeSpec[] = [
  ...DISCOVERY_NODES,
  ...STRATEGY_NODES,
  ...DESIGN_NODES,
  ...ENGINEERING_NODES,
  ...AI_SKILL_NODES,
  ...VALIDATION_NODES,
  ...TRANSITION_NODES,
  ...OUTPUT_NODES,
]
