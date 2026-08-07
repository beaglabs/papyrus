import type { NodeTypeSpec } from '../types.js'

/** Product Strategy — define what should be built. All `artifact` flow role. */
const GOALISH: Array<Partial<NodeTypeSpec> & { type: string; title: string }> = [
  { type: 'vision', title: 'Vision', icon: 'telescope' },
  { type: 'product-goal', title: 'Product Goal', icon: 'target' },
  { type: 'objective', title: 'Objective', icon: 'compass' },
  { type: 'okr', title: 'OKR', icon: 'medal' },
  { type: 'outcome', title: 'Outcome', icon: 'check-badge' },
]

export const STRATEGY_NODES: NodeTypeSpec[] = [
  ...GOALISH.map(
    (g): NodeTypeSpec => ({
      type: g.type,
      title: g.title,
      icon: g.icon ?? 'target',
      category: 'strategy',
      flowRole: 'artifact',
      description: 'A product goal-shape node.',
      fields: [
        { key: 'statement', label: 'Statement', type: 'markdown', required: true },
        { key: 'measure', label: 'Measure', type: 'text' },
        { key: 'target', label: 'Target', type: 'text' },
      ],
    }),
  ),
  {
    type: 'product-canvas',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'canvas',
    title: 'Product Canvas',
    description: 'Lean-canvas-style summary of the product hypothesis.',
    fields: [
      { key: 'problem', label: 'Problem', type: 'markdown' },
      { key: 'solution', label: 'Solution', type: 'markdown' },
      { key: 'uniqueValue', label: 'Unique Value Proposition', type: 'markdown' },
      { key: 'segments', label: 'Customer Segments', type: 'list', multi: true },
    ],
  },
  {
    type: 'value-proposition',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'gem',
    title: 'Value Proposition',
    description: 'The value promised to a segment.',
    fields: [
      { key: 'statement', label: 'Statement', type: 'markdown', required: true },
      { key: 'segments', label: 'Segments', type: 'list', multi: true },
    ],
  },
  {
    type: 'feature',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'cube',
    title: 'Feature',
    description: 'A discrete product capability to build.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'markdown' },
      { key: 'priority', label: 'Priority', type: 'select', options: ['low', 'med', 'high'] },
    ],
  },
  {
    type: 'epic',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'box',
    title: 'Epic',
    description: 'A large body of work decomposed into stories.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'markdown' },
    ],
  },
  {
    type: 'capability',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'stack',
    title: 'Capability',
    description: 'A higher-level capability composed of features.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'markdown' },
    ],
  },
  {
    type: 'user-story',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'story',
    title: 'User Story',
    description: '“As a … I want … so that …”.',
    fields: [
      { key: 'asA', label: 'As a', type: 'ref', refType: 'persona', required: true },
      { key: 'iWant', label: 'I want', type: 'text', required: true },
      { key: 'soThat', label: 'So that', type: 'text' },
      {
        key: 'acceptanceCriteria',
        label: 'Acceptance Criteria',
        type: 'ref',
        refType: 'acceptance-criteria',
        multi: true,
      },
    ],
  },
  {
    type: 'acceptance-criteria',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'check',
    title: 'Acceptance Criteria',
    description: 'Given/When/Then criterion for a story.',
    fields: [
      { key: 'given', label: 'Given', type: 'text' },
      { key: 'when', label: 'When', type: 'text' },
      { key: 'then', label: 'Then', type: 'text' },
    ],
  },
  {
    type: 'success-metric',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'chart',
    title: 'Success Metric',
    description: 'How success will be measured.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'formula', label: 'Formula', type: 'text' },
      { key: 'target', label: 'Target', type: 'text' },
    ],
  },
  {
    type: 'kpi',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'gauge',
    title: 'KPI',
    description: 'A key performance indicator.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'target', label: 'Target', type: 'text' },
    ],
  },
  {
    type: 'experiment',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'beaker',
    title: 'Experiment',
    description: 'A planned experiment to validate a hypothesis.',
    fields: [
      { key: 'hypothesis', label: 'Hypothesis', type: 'text', required: true },
      { key: 'result', label: 'Result', type: 'markdown' },
    ],
  },
  {
    type: 'decision',
    category: 'strategy',
    flowRole: 'artifact',
    icon: 'gavel',
    title: 'Decision',
    description: 'A recorded decision and its rationale.',
    fields: [
      { key: 'decision', label: 'Decision', type: 'markdown', required: true },
      { key: 'rationale', label: 'Rationale', type: 'markdown' },
    ],
  },
]
