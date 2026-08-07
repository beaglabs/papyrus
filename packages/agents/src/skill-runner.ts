/**
 * Skill runner — executes AI Skill nodes by resolving upstream inputs,
 * calling the LLM, and producing output nodes.
 *
 * Flow:
 * 1. Look up the SkillSpec by skillId
 * 2. Resolve `consumes` edges to find upstream input nodes
 * 3. Build a focused prompt with skill context + input data
 * 4. Call the LLM to produce output
 * 5. Parse and return the produced nodes
 */
import { createOpenAI } from '@ai-sdk/openai'
import { AI_SKILLS, type SkillSpec } from '@papyrus/core/nodes/catalog/ai-skill'
import type { CanvasNodeDoc } from '@papyrus/core/nodes/types'
import { generateText } from 'ai'

export interface SkillInput {
  node: CanvasNodeDoc
  edgeLabel?: string
}

export interface SkillOutput {
  type: string
  title: string
  content: string
  category: string
}

export interface SkillRunResult {
  skillId: string
  status: 'done' | 'error'
  outputs: SkillOutput[]
  error?: string
  runId: string
}

/**
 * Find a skill spec by ID.
 */
export function getSkillSpec(skillId: string): SkillSpec | undefined {
  return AI_SKILLS.find((s: SkillSpec) => s.id === skillId)
}

/**
 * List all available skills.
 */
export function listSkills(): SkillSpec[] {
  return AI_SKILLS
}

/**
 * Run a skill with the given inputs.
 *
 * @param skillId - The skill to run
 * @param inputs - Upstream nodes that satisfy the skill's `consumes` contract
 * @param apiKey - OpenRouter API key
 * @param model - Model to use
 */
export async function runSkill(
  skillId: string,
  inputs: SkillInput[],
  apiKey: string,
  model = 'inclusionai/ling-3.0-tiny:free',
): Promise<SkillRunResult> {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const spec = getSkillSpec(skillId)

  if (!spec) {
    return { skillId, status: 'error', outputs: [], error: `Unknown skill: ${skillId}`, runId }
  }

  if (inputs.length === 0) {
    return {
      skillId,
      status: 'error',
      outputs: [],
      error: `No inputs provided. This skill consumes: ${spec.consumes.join(', ')}`,
      runId,
    }
  }

  const openrouter = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  })

  // Build the skill execution prompt
  const systemPrompt = buildSkillPrompt(spec, inputs)
  const userMessage = `Execute the "${spec.title}" skill with the provided inputs. Produce the expected outputs: ${spec.produces.join(', ')}.`

  try {
    const result = await generateText({
      model: openrouter(model),
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0.7,
      maxOutputTokens: 4096,
    })

    const outputs = parseSkillOutputs(result.text, spec)

    return { skillId, status: 'done', outputs, runId }
  } catch (err) {
    return {
      skillId,
      status: 'error',
      outputs: [],
      error: err instanceof Error ? err.message : 'Skill execution failed',
      runId,
    }
  }
}

/**
 * Build a system prompt for skill execution.
 */
function buildSkillPrompt(spec: SkillSpec, inputs: SkillInput[]): string {
  const inputSummaries = inputs
    .map((inp) => {
      const title = (inp.node.fields.title as string) ?? inp.node.type
      const content = (inp.node.fields.content as string) ?? '(no content)'
      return `### ${title} (${inp.node.type})\n${content}`
    })
    .join('\n\n')

  return `You are executing the "${spec.title}" skill on the Papyrus platform.

## Skill Description
${spec.description}

## Expected Outputs
This skill produces: ${spec.produces.join(', ')}

## Input Data
${inputSummaries}

## Instructions
Based on the input data above, produce the expected output artifacts. For EACH output artifact, respond with a JSON object in a code block:

\`\`\`json
{
  "action": "create_node",
  "outputs": [
    {
      "type": "<node-type from: ${spec.produces.join(', ')}>",
      "title": "<descriptive title>",
      "content": "<detailed content in markdown>",
      "category": "<category>"
    }
  ]
}
\`\`\`

You may produce multiple outputs if the skill generates more than one artifact. Each output should be a complete, detailed artifact based on the input data.`
}

/**
 * Parse LLM output into skill outputs.
 */
function parseSkillOutputs(text: string, spec: SkillSpec): SkillOutput[] {
  // Try code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]) as Record<string, unknown>
      if (parsed.action === 'create_node' && Array.isArray(parsed.outputs)) {
        return parsed.outputs.map((o: Record<string, unknown>) => ({
          type: String(o.type ?? spec.produces[0]),
          title: String(o.title ?? 'Untitled'),
          content: String(o.content ?? ''),
          category: String(o.category ?? 'strategy'),
        }))
      }
    } catch {
      // not valid JSON
    }
  }

  // Try raw JSON
  const jsonMatch = text.match(/\{[\s\S]*"action"\s*:\s*"create_node"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      if (Array.isArray(parsed.outputs)) {
        return parsed.outputs.map((o: Record<string, unknown>) => ({
          type: String(o.type ?? spec.produces[0]),
          title: String(o.title ?? 'Untitled'),
          content: String(o.content ?? ''),
          category: String(o.category ?? 'strategy'),
        }))
      }
    } catch {
      // not valid JSON
    }
  }

  // Fallback: create a single output from the raw text
  return [
    {
      type: spec.produces[0] ?? 'feature',
      title: `${spec.title} Output`,
      content: text,
      category: 'strategy',
    },
  ]
}
