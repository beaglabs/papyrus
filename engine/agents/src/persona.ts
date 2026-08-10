import {
  type ArtifactEnvelope,
  coerceArtifactEnvelope,
  unwrapUswdsArtifact,
} from '@papyrus/core/artifacts/envelope'
import {
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
  artifact?: ArtifactEnvelope
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
  /** Artifact contract selected by the request orchestrator. */
  expectedArtifact?: string
}

export function buildPersonaSystemPrompt(
  personaPrompt: string,
  projectSystemPrompt?: string,
  expectedArtifact?: string,
): string {
  const projectPrompt = projectSystemPrompt?.trim()
  const projectSection = projectPrompt
    ? `\n\n## Project System Prompt\nThe following project-specific instructions are authoritative for the work product. Follow them while retaining your assigned professional role.\n\n${projectPrompt}`
    : ''
  const artifactSection = expectedArtifact
    ? `\n\n## Required Artifact Contract\nFor this request, the expected artifact type is "${expectedArtifact}". Use that type unless the deliverable is intentionally decomposed into more specific compatible artifacts. Do not substitute an application or source-code workspace for prose, requirements, user stories, metrics, design guidance, architecture, or analysis. Only emit application artifacts when you are returning actual source files in language-tagged code fences with explicit file paths.`
    : ''
  return `${personaPrompt}${projectSection}${artifactSection}`
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
  const systemPrompt = buildPersonaSystemPrompt(
    personaPrompt,
    options.projectSystemPrompt,
    options.expectedArtifact,
  )

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

      let result = extractArtifacts(rawText, personaId, options.expectedArtifact)
      const request = messages.at(-1)?.content ?? ''
      if (
        personaId === 'designer' &&
        /\b(wireframe|mockup)\b/i.test(request) &&
        !result.nodes.some(
          (node) => node.type === 'ui-mockup' && unwrapUswdsArtifact(node.artifact),
        )
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
        result = extractArtifacts(rawText, personaId, options.expectedArtifact)

        if (
          !result.nodes.some(
            (node) => node.type === 'ui-mockup' && unwrapUswdsArtifact(node.artifact),
          )
        ) {
          const wireframe = createFallbackUswdsWireframe(request)
          const artifact = coerceArtifactEnvelope(
            'ui-mockup',
            wireframe.title,
            JSON.stringify(wireframe),
            personaId,
          )
          console.warn(
            '[papyrus] Designer output failed papyrus.uswds-wireframe/v1 validation after repair; using a schema-valid recovery artifact.',
          )
          result = {
            text: 'Created a schema-valid USWDS wireframe proposal for review.',
            nodes: [
              {
                type: 'ui-mockup',
                category: 'output',
                title: wireframe.title,
                content: JSON.stringify(wireframe, null, 2),
                status: 'proposed',
                artifact,
              },
            ],
          }
        }
      }

      if (
        result.nodes.length === 0 &&
        rawText.trim() &&
        /\b(create|generate|draft|design|analyze|build|review|map|define|plan)\b/i.test(request)
      ) {
        const type =
          options.expectedArtifact ??
          (personaId === 'security'
            ? 'security-report'
            : personaId === 'engineer'
              ? /\bapi|endpoint|openapi\b/i.test(request)
                ? 'api'
                : 'application'
              : personaId === 'designer'
                ? 'specification'
                : 'specification')
        const title =
          type === 'security-report'
            ? 'Security review'
            : type === 'api'
              ? 'API specification'
              : type === 'application'
                ? 'Technical deliverable'
                : 'Generated specification'
        result = {
          text: `Created **${title}** for review.`,
          nodes: [
            {
              type,
              category: 'output',
              title,
              content: rawText,
              status: 'proposed',
              artifact: coerceArtifactEnvelope(type, title, rawText, personaId),
            },
          ],
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
export function extractArtifacts(
  rawText: string,
  persona = 'agent',
  expectedArtifact?: string,
): { text: string; nodes: CanvasNode[] } {
  const artifactRegex = /<artifact\s+([^>]+)>([\s\S]*?)<\/artifact>/gi
  const nodes: CanvasNode[] = []
  for (const match of rawText.matchAll(artifactRegex)) {
    const attributes = new Map<string, string>()
    for (const attribute of (match[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (attribute[1]) attributes.set(attribute[1], attribute[2] ?? '')
    }
    const declaredType = attributes.get('type') || 'specification'
    const type = normalizeArtifactType(declaredType, expectedArtifact)
    const title = attributes.get('title') || type
    const content = (match[2] ?? '').trim()
    const artifact = coerceArtifactEnvelope(type, title, content, persona)
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

  if (nodes.length > 0) {
    const cleanedText = rawText.replace(artifactRegex, '').trim()
    return {
      text:
        cleanedText ||
        `Created ${nodes.length} canvas ${nodes.length === 1 ? 'proposal' : 'proposals'} for review.`,
      nodes,
    }
  }

  const standaloneWireframe = parseUswdsWireframeArtifact(rawText)
  if (standaloneWireframe) {
    const artifact = coerceArtifactEnvelope(
      'ui-mockup',
      standaloneWireframe.title,
      JSON.stringify(standaloneWireframe),
      persona,
    )
    return {
      text: 'Created a USWDS wireframe proposal for review.',
      nodes: [
        {
          type: 'ui-mockup',
          category: 'output',
          title: standaloneWireframe.title,
          content: JSON.stringify(standaloneWireframe, null, 2),
          status: 'proposed',
          artifact,
        },
      ],
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

  // Never silently lose a substantive generated deliverable. Code and structured
  // responses become a reviewable generic artifact even when a provider omitted tags.
  const looksLikeDeliverable =
    /```|^#{1,3}\s|\b(openapi|paths:|components:|threat model|architecture)\b/im.test(rawText)
  if (looksLikeDeliverable && rawText.trim()) {
    const containsSourceCode =
      /```(?:typescript|ts|tsx|javascript|js|jsx|css|html|python|py|shell|bash|sh|rust|go|java|sql|vue|svelte)\b/i.test(
        rawText,
      )
    const inferredKind = /\b(openapi|paths:)\b/i.test(rawText)
      ? 'api'
      : containsSourceCode
        ? 'application'
        : 'specification'
    const kind = expectedArtifact ?? inferredKind
    const title =
      kind === 'api'
        ? 'API specification'
        : kind === 'application'
          ? 'Generated application'
          : 'Generated artifact'
    return {
      text: `Created **${title}** for review.`,
      nodes: [
        {
          type: kind,
          category: 'output',
          title,
          content: rawText,
          status: 'proposed',
          artifact: coerceArtifactEnvelope(kind, title, rawText, persona),
        },
      ],
    }
  }

  return { text: rawText, nodes: [] }
}

function normalizeArtifactType(declaredType: string, expectedArtifact?: string): string {
  if (!expectedArtifact || declaredType === expectedArtifact) return declaredType

  const compatible: Record<string, string[]> = {
    specification: ['specification', 'user-story', 'success-metric'],
    application: ['application', 'source-code', 'mcp-server', 'skill-creator'],
    'security-report': ['security-report', 'threat-model', 'specification', 'dataset'],
  }
  return compatible[expectedArtifact]?.includes(declaredType) ? declaredType : expectedArtifact
}

/** Backwards-compatible single-artifact helper for existing callers. */
export function extractArtifact(rawText: string): { text: string; node?: CanvasNode } {
  const result = extractArtifacts(rawText)
  return { text: result.text, node: result.nodes[0] }
}
