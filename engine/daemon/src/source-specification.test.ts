import { buildSystemPrompt } from '@papyrus/agents'
import { describe, expect, it } from 'vitest'
import { createSourceSpecificationNode, getProjectSystemPrompt } from './source-specification.js'

describe('source specification', () => {
  it('creates an editable project system prompt node', () => {
    const node = createSourceSpecificationNode('project-1', 'Mission Planner', 'member-1')

    expect(node.projectId).toBe('project-1')
    expect(node.flowRole).toBe('source')
    expect(node.type).toBe('specification')
    expect(node.fields.title).toBe('Mission Planner system prompt')
    expect(node.fields.content).toContain('# Mission Planner')
  })

  it('reads the source content as the project system prompt', () => {
    const source = createSourceSpecificationNode('project-1', 'Mission Planner', 'member-1')
    source.fields.content = '  Keep all outputs concise.  '

    expect(getProjectSystemPrompt([source])).toBe('Keep all outputs concise.')
  })

  it('places the editable project prompt in the model system instructions', () => {
    const system = buildSystemPrompt(
      'Do not propose cloud dependencies.',
    )

    expect(system).toContain('## Project Context')
    expect(system).toContain('Do not propose cloud dependencies.')
  })
})
