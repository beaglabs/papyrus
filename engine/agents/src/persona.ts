import { createOpenAI } from '@ai-sdk/openai'
/**
 * Persona agent — calls an OpenAI-compatible LLM (OpenRouter) with a persona
 * system prompt and returns structured responses.
 *
 * The agent produces two types of responses:
 * 1. Conversational text (clean markdown — no raw JSON)
 * 2. Artifact creation commands via <artifact> tags — extracted automatically
 */
import { generateText } from 'ai'
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
  /** Clean markdown text shown to the user (artifact tags stripped). */
  text: string
  /** Extracted artifact node, if the agent created one. */
  node?: CanvasNode
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
export function createPersonaAgent(
  personaId: string,
  apiKey: string,
  model = 'inclusionai/ling-3.0-tiny:free',
): PersonaAgent {
  const systemPrompt = PERSONA_PROMPTS[personaId]
  if (!systemPrompt) throw new Error(`Unknown persona: ${personaId}`)

  const openrouter = createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  })

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
      const result = await generateText({
        model: openrouter(model),
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.7,
        maxOutputTokens: 4096,
      })

      const rawText = result.text

      // Extract artifact and clean the text
      const { text, node } = extractArtifact(rawText)

      return { text, node }
    },
  }
}

/**
 * Extract an <artifact> tag from the agent response.
 * Returns the cleaned text (tag removed) and the parsed node.
 *
 * Also handles legacy JSON format for backwards compatibility.
 */
export function extractArtifact(rawText: string): { text: string; node?: CanvasNode } {
  // Match <artifact type="..." title="...">content</artifact>
  const artifactRegex = /<artifact\s+type="([^"]+)"\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/artifact>/i
  const match = rawText.match(artifactRegex)

  if (match) {
    const [, type, title, content] = match
    const cleanedText = rawText.replace(artifactRegex, '').trim()
    return {
      text: cleanedText || `Created **${title || type}** and added it to the canvas.`,
      node: {
        type: type!,
        category: 'output',
        title: title || type!,
        content: content!.trim(),
        status: 'generated',
      },
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
          text: cleaned || `Created **${(parsed.node as { title?: string }).title ?? 'artifact'}**.`,
          node: parsed.node as CanvasNode,
        }
      }
    } catch {
      // not valid JSON
    }
  }

  return { text: rawText }
}
