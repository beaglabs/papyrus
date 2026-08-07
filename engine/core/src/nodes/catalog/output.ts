import type { NodeTypeSpec } from '../types.js'

/**
 * Output nodes — generation targets that produce deployable artifacts.
 *
 * Each output type corresponds to a skill pipeline:
 * - specification: the source spec that drives all other generations
 * - ui-mockup: frontend design (HTML/CSS/React components)
 * - application: full-stack application code
 * - mcp-server: MCP server scaffold
 * - skill-creator: agent skill scaffold
 * - api: REST/GraphQL API spec + implementation
 * - dataset: Document generation (PDF, Docx, XLSX, PPTX)
 */
export const OUTPUT_NODES: NodeTypeSpec[] = [
  {
    type: 'specification',
    category: 'output',
    flowRole: 'source',
    icon: 'doc',
    title: 'Specification',
    description: 'The project specification that drives all generations.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Specification', type: 'markdown', required: true },
      { key: 'format', label: 'Format', type: 'select', options: ['freeform', 'prd', 'rfp', 'user-story'] },
    ],
  },
  {
    type: 'ui-mockup',
    category: 'output',
    flowRole: 'exit',
    icon: 'layout',
    title: 'UI Mockup',
    description: 'Frontend design — HTML/CSS/React components with live preview.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Description', type: 'markdown' },
      { key: 'preview', label: 'Preview HTML', type: 'blob' },
      { key: 'code', label: 'Source Code', type: 'blob' },
      { key: 'framework', label: 'Framework', type: 'select', options: ['html', 'react', 'vue', 'svelte'] },
    ],
  },
  {
    type: 'application',
    category: 'output',
    flowRole: 'exit',
    icon: 'app',
    title: 'Application',
    description: 'Full-stack application with frontend, backend, and config.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Description', type: 'markdown' },
      { key: 'preview', label: 'Preview', type: 'blob' },
      { key: 'code', label: 'Source Code', type: 'blob' },
      { key: 'stack', label: 'Stack', type: 'select', options: ['react-node', 'nextjs', 'vue-node', 'remix', 'sveltekit'] },
    ],
  },
  {
    type: 'mcp-server',
    category: 'output',
    flowRole: 'exit',
    icon: 'server',
    title: 'MCP Server',
    description: 'Model Context Protocol server scaffold with tool definitions.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Description', type: 'markdown' },
      { key: 'code', label: 'Server Code', type: 'blob' },
      { key: 'tools', label: 'Tool Definitions', type: 'json' },
    ],
  },
  {
    type: 'skill-creator',
    category: 'output',
    flowRole: 'exit',
    icon: 'puzzle',
    title: 'Skill',
    description: 'Agent skill scaffold with SKILL.md and resources.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Description', type: 'markdown' },
      { key: 'code', label: 'SKILL.md', type: 'blob' },
      { key: 'scripts', label: 'Scripts', type: 'json' },
    ],
  },
  {
    type: 'api',
    category: 'output',
    flowRole: 'exit',
    icon: 'plug',
    title: 'API',
    description: 'REST/GraphQL API specification and implementation.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Description', type: 'markdown' },
      { key: 'preview', label: 'Interactive Docs', type: 'blob' },
      { key: 'code', label: 'Source Code', type: 'blob' },
      { key: 'spec', label: 'OpenAPI Spec', type: 'json' },
      { key: 'protocol', label: 'Protocol', type: 'select', options: ['rest', 'graphql', 'grpc', 'websocket'] },
    ],
  },
  {
    type: 'dataset',
    category: 'output',
    flowRole: 'exit',
    icon: 'table',
    title: 'Dataset / Document',
    description: 'Generated document — PDF, Word, Excel, or PowerPoint.',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'content', label: 'Content', type: 'markdown' },
      { key: 'preview', label: 'Preview', type: 'blob' },
      { key: 'data', label: 'Data', type: 'json' },
      { key: 'format', label: 'Format', type: 'select', options: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'json'] },
    ],
  },
]
