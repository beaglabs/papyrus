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

/**
 * Create an agent for a given persona.
 */
export function createPersonaAgent(personaId: string, provider: ModelProviderConfig): PersonaAgent {
  const systemPrompt = PERSONA_PROMPTS[personaId]
  if (!systemPrompt) throw new Error(`Unknown persona: ${personaId}`)

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
      const rawText = await generateModelText(provider, {
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.7,
        maxOutputTokens: 4096,
      })

      // Extract artifact and clean the text
      const { text, nodes } = extractArtifacts(rawText)

      return { text, nodes }
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
  const artifactRegex = /<artifact\s+type="([^"]+)"\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/artifact>/gi
  const nodes: CanvasNode[] = []
  for (const match of rawText.matchAll(artifactRegex)) {
    const type = match[1] ?? 'specification'
    const title = match[2] || type
    nodes.push({
      type,
      category: 'output',
      title,
      content: (match[3] ?? '').trim(),
      status: 'proposed',
    })
  }

  if (nodes.length > 0) {
    const cleanedText = rawText.replace(artifactRegex, '').trim()
    return {
      text:
        cleanedText ||
        `Created ${nodes.length} canvas ${nodes.length === 1 ? 'proposal' : 'proposals'} for review.`,
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
