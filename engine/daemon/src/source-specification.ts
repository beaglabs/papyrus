import type { CanvasNodeDoc } from '@papyrus/core/nodes/types'

export function createSourceSpecificationNode(
  projectId: string,
  projectName: string,
  createdBy: string,
): CanvasNodeDoc {
  return {
    id: `node-spec-${crypto.randomUUID()}`,
    projectId,
    type: 'specification',
    category: 'output',
    flowRole: 'source',
    position: { x: 100, y: 200 },
    fields: {
      title: `${projectName} system prompt`,
      content: `# ${projectName}\n\nDescribe what the agents are building, who it serves, the problem it solves, and any constraints they must follow.`,
      format: 'markdown',
    },
    status: 'draft',
    createdBy,
    updatedAt: Date.now(),
  }
}

export function getProjectSystemPrompt(nodes: CanvasNodeDoc[]): string | undefined {
  const source = nodes.find((node) => node.flowRole === 'source')
  const content = source?.fields.content
  if (typeof content !== 'string') return undefined
  const trimmed = content.trim()
  return trimmed || undefined
}
