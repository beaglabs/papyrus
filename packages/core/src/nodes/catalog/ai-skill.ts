import type { NetworkProfile } from '../../profiles/config.js'
import type { NodeTypeSpec } from '../types.js'

/**
 * The AI Skill node — a single canvas node type whose `skillId` selects which
 * Mastra agent/workflow to run. It consumes upstream artifact nodes and
 * produces new artifact nodes. Traces stream back to the node via Mastra's
 * `data-workflow` / `data-network` parts; `reviewable` skills gate on a
 * `workflowRoute()` suspend/resume before writing produced nodes to the CRDT.
 */
export const AI_SKILL_NODE: NodeTypeSpec = {
  type: 'ai-skill',
  category: 'ai-skill',
  flowRole: 'skill',
  icon: 'sparkles',
  title: 'AI Skill',
  description: 'Runs a Mastra agent that consumes upstream artifacts and produces new ones.',
  reviewable: true,
  fields: [
    { key: 'skillId', label: 'Skill', type: 'select', options: [], required: true },
    { key: 'inputs', label: 'Inputs', type: 'ref', refType: '', multi: true },
    { key: 'runId', label: 'Last Run', type: 'text' },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['idle', 'running', 'awaiting-review', 'done', 'error'],
    },
  ],
}

/**
 * A Papyrus AI Skill = a packaged Mastra agent/workflow with a typed contract.
 * The `papyrus skills create` / `add` / `list` CLI commands manage these.
 * `consumes`/`produces` reference node `type` ids from the catalog.
 */
export interface SkillSpec {
  id: string
  title: string
  description: string
  consumes: string[]
  produces: string[]
  /** Default human-review gate before produced nodes are committed. */
  reviewable?: boolean
  profiles?: NetworkProfile[]
}

/** Reference skills shipped in P3; the rest are target skills for P4+. */
export const AI_SKILLS: SkillSpec[] = [
  {
    id: 'story-generator',
    title: 'Story Generator',
    description: 'Generates User Stories from Features + Personas.',
    consumes: ['feature', 'persona'],
    produces: ['user-story'],
    reviewable: true,
  },
  {
    id: 'security-architect',
    title: 'Security Architect',
    description: 'Produces a Threat Model from an Architecture.',
    consumes: ['architecture'],
    produces: ['threat-model'],
    reviewable: true,
  },
  {
    id: 'accessibility-auditor',
    title: 'Accessibility Auditor',
    description: 'Audits Screens/Wireframes against WCAG.',
    consumes: ['screen', 'wireframe', 'component'],
    produces: ['accessibility-review'],
    reviewable: true,
  },
  // Target skills (P4+):
  {
    id: 'requirements-writer',
    title: 'Requirements Writer',
    description: 'Drafts requirements from Discovery inputs.',
    consumes: ['mission-need', 'interview', 'insight'],
    produces: ['feature'],
    reviewable: true,
  },
  {
    id: 'ux-reviewer',
    title: 'UX Reviewer',
    description: 'Reviews flows and screens for UX issues.',
    consumes: ['screen', 'user-journey'],
    produces: ['design-review'],
  },
  {
    id: 'api-designer',
    title: 'API Designer',
    description: 'Designs an OpenAPI contract from Features.',
    consumes: ['feature', 'data-model'],
    produces: ['api'],
  },
  {
    id: 'data-mapper',
    title: 'Data Mapper',
    description: 'Produces a data model + schema.',
    consumes: ['feature'],
    produces: ['data-model', 'schema'],
  },
  {
    id: 'threat-model-generator',
    title: 'Threat Model Generator',
    description: 'Alternative threat-model skill.',
    consumes: ['architecture'],
    produces: ['threat-model'],
  },
  {
    id: 'test-generator',
    title: 'Test Generator',
    description: 'Generates Test Plans + Cases.',
    consumes: ['user-story', 'api'],
    produces: ['test-plan', 'test-case'],
  },
  {
    id: 'documentation-writer',
    title: 'Documentation Writer',
    description: 'Writes documentation artifacts.',
    consumes: ['feature', 'api'],
    produces: ['sop'],
  },
  {
    id: 'proposal-writer',
    title: 'Proposal Writer',
    description: 'Assembles an Acquisition Package.',
    consumes: ['product-canvas', 'validation-report'],
    produces: ['acquisition-package'],
  },
  {
    id: 'mbse-assistant',
    title: 'MBSE Assistant',
    description: 'Model-Based Systems Engineering assistance.',
    consumes: ['architecture', 'mission-need'],
    produces: ['architecture'],
  },
  {
    id: 'risk-analyzer',
    title: 'Risk Analyzer',
    description: 'Surfaces risks and constraints.',
    consumes: ['architecture', 'threat-model'],
    produces: ['risk'],
  },
  {
    id: 'transition-planner',
    title: 'Transition Planner',
    description: 'Builds a Transition + Sustainment plan.',
    consumes: ['product-canvas', 'deployment'],
    produces: ['transition-plan', 'sustainment-plan'],
  },
]

export const AI_SKILL_NODES: NodeTypeSpec[] = [AI_SKILL_NODE]
