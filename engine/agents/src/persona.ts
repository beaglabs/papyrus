import {
  type UswdsWireframeArtifact,
  createFallbackUswdsWireframe,
  parseUswdsWireframeArtifact,
} from '@papyrus/core/artifacts/uswds-wireframe'
/**
 * Persona agent — calls the configured model provider with a persona
 * system prompt and returns structured responses.
 *
 * The agent produces two types of responses:
 * 1. Conversational text (clean markdown — no raw JSON)
 * 2. Artifact creation commands via <artifact> tags — extracted automatically
 */
import { type ModelProviderConfig, generateModelText } from './model-provider.js'
import { PERSONA_PROMPTS } from './prompts.js'

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CanvasNode {
  type: string
  category: string
  title: string
  content: string
  status: string
  parentId?: string
  artifact?: UswdsWireframeArtifact
}

export interface AgentResponse {
  /** Short status text shown to the user (artifact tags stripped). */
  text: string
  /** Extracted artifact nodes proposed for human review. */
  nodes: CanvasNode[]
}

export interface PersonaAgent {
  id: string
  name: string
  role: string
  chat: (messages: AgentMessage[]) => Promise<AgentResponse>
}

export interface PersonaAgentOptions {
  /** Editable project-level instructions supplied by the source specification node. */
  projectSystemPrompt?: string
}

export function buildPersonaSystemPrompt(
  personaPrompt: string,
  projectSystemPrompt?: string,
): string {
  const projectPrompt = projectSystemPrompt?.trim()
  if (!projectPrompt) return personaPrompt
  return `${personaPrompt}\n\n## Project System Prompt\nThe following project-specific instructions are authoritative for the work product. Follow them while retaining your assigned professional role.\n\n${projectPrompt}`
}

/**
 * Create an agent for a given persona.
 */
export function createPersonaAgent(
  personaId: string,
  provider: ModelProviderConfig,
  options: PersonaAgentOptions = {},
): PersonaAgent {
  const personaPrompt = PERSONA_PROMPTS[personaId]
  if (!personaPrompt) throw new Error(`Unknown persona: ${personaId}`)
  const systemPrompt = buildPersonaSystemPrompt(personaPrompt, options.projectSystemPrompt)

  const personaNames: Record<string, { name: string; role: string }> = {
    pm: { name: 'Product Manager', role: 'PM' },
    designer: { name: 'Designer', role: 'DESIGN' },
    engineer: { name: 'Engineer', role: 'ENG' },
    security: { name: 'Security Reviewer', role: 'SEC' },
  }

  const { name, role } = personaNames[personaId] ?? {
    name: personaId,
    role: personaId.toUpperCase(),
  }

  return {
    id: personaId,
    name,
    role,
    chat: async (messages: AgentMessage[]): Promise<AgentResponse> => {
      let rawText = await generateModelText(provider, {
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.7,
        maxOutputTokens: 4096,
      })

      let result = extractArtifacts(rawText)
      const request = messages.at(-1)?.content ?? ''
      if (
        personaId === 'designer' &&
        /\b(wireframe|mockup)\b/i.test(request) &&
        !result.nodes.some((node) => node.type === 'ui-mockup' && node.artifact)
      ) {
        rawText = await generateModelText(provider, {
          system: systemPrompt,
          messages: [
            ...messages.map((message) => ({ role: message.role, content: message.content })),
            { role: 'assistant', content: rawText },
            {
              role: 'user',
              content:
                'Repair the deliverable. Return one ui-mockup artifact whose body is valid papyrus.uswds-wireframe/v1 JSON. Use USWDS section kinds only. Do not use ASCII art, markdown, prose, or HTML inside the artifact.',
            },
          ],
          temperature: 0.2,
          maxOutputTokens: 4096,
        })
        result = extractArtifacts(rawText)

        if (!result.nodes.some((node) => node.type === 'ui-mockup' && node.artifact)) {
          const artifact = createFallbackUswdsWireframe(request)
          console.warn(
            '[papyrus] Designer output failed papyrus.uswds-wireframe/v1 validation after repair; using a schema-valid recovery artifact.',
          )
          result = {
            text: 'Created a schema-valid USWDS wireframe proposal for review.',
            nodes: [
              {
                type: 'ui-mockup',
                category: 'output',
                title: artifact.title,
                content: JSON.stringify(artifact, null, 2),
                status: 'proposed',
                artifact,
              },
            ],
          }
        }
      }

      return result
    },
  }
}

/**
 * Extract an <artifact> tag from the agent response.
 * Returns the cleaned text (tag removed) and the parsed node.
 *
 * Also handles legacy JSON format for backwards compatibility.
 */
export function extractArtifacts(rawText: string): { text: string; nodes: CanvasNode[] } {
  const artifactRegex = /<artifact\s+([^>]+)>([\s\S]*?)<\/artifact>/gi
  const nodes: CanvasNode[] = []
  let invalidWireframes = 0
  for (const match of rawText.matchAll(artifactRegex)) {
    const attributes = new Map<string, string>()
    for (const attribute of (match[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (attribute[1]) attributes.set(attribute[1], attribute[2] ?? '')
    }
    const type = attributes.get('type') || 'specification'
    const title = attributes.get('title') || type
    const content = (match[2] ?? '').trim()
    const artifact = type === 'ui-mockup' ? parseUswdsWireframeArtifact(content) : undefined
    if (type === 'ui-mockup' && !artifact) {
      invalidWireframes++
      continue
    }
    nodes.push({
      type,
      category: 'output',
      title,
      content,
      status: 'proposed',
      parentId: attributes.get('parent') || undefined,
      artifact,
    })
  }

  if (nodes.length > 0 || invalidWireframes > 0) {
    const cleanedText = rawText.replace(artifactRegex, '').trim()
    return {
      text:
        cleanedText ||
        (invalidWireframes > 0
          ? 'The wireframe response did not match the required USWDS artifact schema. Please retry.'
          : `Created ${nodes.length} canvas ${nodes.length === 1 ? 'proposal' : 'proposals'} for review.`),
      nodes,
    }
  }

  // Legacy: try JSON code block format
  const codeBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlockMatch?.[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]) as Record<string, unknown>
      if (parsed.action === 'create_node' && parsed.node) {
        const cleaned = rawText.replace(codeBlockMatch[0], '').trim()
        return {
          text:
            cleaned || `Created **${(parsed.node as { title?: string }).title ?? 'artifact'}**.`,
          nodes: [parsed.node as CanvasNode],
        }
      }
    } catch {
      // not valid JSON
    }
  }

  return { text: rawText, nodes: [] }
}

/** Backwards-compatible single-artifact helper for existing callers. */
export function extractArtifact(rawText: string): { text: string; node?: CanvasNode } {
  const result = extractArtifacts(rawText)
  return { text: result.text, node: result.nodes[0] }
}
