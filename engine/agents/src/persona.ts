import { type ArtifactEnvelope, coerceArtifactEnvelope } from '@papyrus/core/artifacts/envelope'
/**
 * Single agent — calls the configured model provider with one
 * system prompt and returns structured responses.
 *
 * The agent produces two types of responses:
 * 1. Conversational text (clean markdown — no raw JSON)
 * 2. Artifact creation commands via <artifact> tags — extracted automatically
 */
import {
  type ModelProviderConfig,
  type StreamCallbacks,
  generateModelProject,
  generateModelText,
  generateModelTextStream,
} from './model-provider.js'
import { AGENT_PROMPT } from './prompts.js'

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
  chatStream: (messages: AgentMessage[], callbacks: StreamCallbacks) => Promise<AgentResponse>
  generateProject: (
    messages: AgentMessage[],
    onProgress?: (phase: 'selecting-scaffold' | 'scaffolding' | 'customizing') => void,
  ) => Promise<AgentResponse>
}

export interface PersonaAgentOptions {
  /** Editable project-level instructions supplied by the source specification node. */
  projectSystemPrompt?: string
  /** Artifact contract selected by the request orchestrator. */
  expectedArtifact?: string
  /** Existing files from a prior generation — passed for iteration requests. */
  existingFiles?: Array<{ path: string; content: string; language?: string }>
  contextFiles?: Array<{ name: string; mimeType: string; content: string }>
  skills?: Array<{ name: string; description?: string; content?: string }>
}

export function buildSystemPrompt(
  projectSystemPrompt?: string,
  expectedArtifact?: string,
  existingFiles?: Array<{ path: string; content: string }>,
  contextFiles?: Array<{ name: string; mimeType: string; content: string }>,
  skills?: Array<{ name: string; description?: string; content?: string }>,
): string {
  let prompt = AGENT_PROMPT

  if (projectSystemPrompt?.trim()) {
    prompt += `\n\n## Project Context\nThe following project-specific instructions are authoritative. Follow them while retaining your role as a senior engineer.\n\n${projectSystemPrompt}`
  }

  if (expectedArtifact) {
    prompt += `\n\n## Required Artifact Type\nFor this request, the expected artifact type is "${expectedArtifact}". Use that type unless the deliverable is intentionally decomposed into more specific compatible artifacts.`
  }

  if (existingFiles && existingFiles.length > 0) {
    prompt +=
      '\n\n## Current Codebase\nThe following files exist in the project. When modifying, preserve files not requested to change and return the complete updated set:\n'
    for (const file of existingFiles) {
      prompt += `\n### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``
    }
  }

  if (contextFiles?.length) {
    prompt +=
      '\n\n## Uploaded Context\nTreat these as reference inputs, not project source files unless explicitly requested.'
    for (const file of contextFiles) {
      prompt += `\n\n### ${file.name} (${file.mimeType})\n${file.content}`
    }
  }

  if (skills?.length) {
    prompt += `\n\n## Uploaded Skills\n${JSON.stringify(skills)}`
  }

  return prompt
}

/**
 * Create the single code-generation agent.
 */
export function createPersonaAgent(
  provider: ModelProviderConfig,
  options: PersonaAgentOptions = {},
): PersonaAgent {
  const systemPrompt = buildSystemPrompt(
    options.projectSystemPrompt,
    options.expectedArtifact,
    options.existingFiles,
    options.contextFiles,
    options.skills,
  )

  return {
    id: 'engineer',
    name: 'Engineer',
    role: 'ENG',
    generateProject: async (
      messages: AgentMessage[],
      onProgress?: (phase: 'selecting-scaffold' | 'scaffolding' | 'customizing') => void,
    ): Promise<AgentResponse> => {
      const project = await generateModelProject(provider, {
        system: `${systemPrompt}\n\nReturn the complete runnable project through the structured project schema. Do not put source code in conversational text. Every relative import must resolve to one of the returned files.`,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxOutputTokens: 16384,
        existingFiles: options.existingFiles,
        onProgress,
      })
      return {
        text: `Created **${project.title}** for review.`,
        nodes: [
          {
            type: 'application',
            category: 'output',
            title: project.title,
            content: project.summary,
            status: 'proposed',
            artifact: {
              schema: 'papyrus.artifact/v1',
              kind: 'application',
              title: project.title,
              summary: project.summary,
              renderer: { type: 'code', options: { template: project.template } },
              files: project.files.map((file) => ({
                ...file,
                path: file.path.startsWith('/') ? file.path : `/${file.path}`,
              })),
              entrypoint: project.entrypoint,
              permissions: { network: 'none' },
              producer: { persona: 'engineer', tool: 'scaffold-and-customize' },
            },
          },
        ],
      }
    },
    chat: async (messages: AgentMessage[]): Promise<AgentResponse> => {
      const rawText = await generateModelText(provider, {
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0.7,
        maxOutputTokens: 4096,
      })

      return extractArtifacts(rawText, options.expectedArtifact)
    },

    chatStream: async (
      messages: AgentMessage[],
      callbacks: StreamCallbacks,
    ): Promise<AgentResponse> => {
      let rawText = ''

      await generateModelTextStream(
        provider,
        {
          system: systemPrompt,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: 0.7,
          maxOutputTokens: 4096,
        },
        {
          onToken: (token) => {
            rawText += token
            callbacks.onToken(token)
          },
          onComplete: () => {},
          onError: (err) => callbacks.onError(err),
        },
      )

      const result = extractArtifacts(rawText, options.expectedArtifact)

      // If the user asked to build something but no artifact was emitted, wrap the response
      if (
        result.nodes.length === 0 &&
        rawText.trim() &&
        /\b(create|generate|build|scaffold|modify|update|fix|extend|add)\b/i.test(
          messages.at(-1)?.content ?? '',
        )
      ) {
        const kind = options.expectedArtifact ?? 'application'
        return {
          text: `Created **${kind}** for review.`,
          nodes: [
            {
              type: kind,
              category: 'output',
              title: 'Generated artifact',
              content: rawText,
              status: 'proposed',
              artifact: coerceArtifactEnvelope(kind, 'Generated artifact', rawText, 'engineer'),
            },
          ],
        }
      }

      callbacks.onComplete(rawText)
      return result
    },
  }
}

/**
 * Extract <artifact> tags from the agent response.
 * Returns cleaned text (tags removed) and parsed nodes.
 */
export function extractArtifacts(
  rawText: string,
  expectedArtifact?: string,
): { text: string; nodes: CanvasNode[] } {
  const artifactRegex = /<artifact\s+([^>]+)>([\s\S]*?)<\/artifact>/gi
  const nodes: CanvasNode[] = []
  for (const match of rawText.matchAll(artifactRegex)) {
    const attributes = new Map<string, string>()
    for (const attribute of (match[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) {
      if (attribute[1]) attributes.set(attribute[1], attribute[2] ?? '')
    }
    const declaredType = attributes.get('type') || 'application'
    const type =
      expectedArtifact && declaredType !== expectedArtifact ? expectedArtifact : declaredType
    const title = attributes.get('title') || type
    const content = (match[2] ?? '').trim()
    const artifact = coerceArtifactEnvelope(type, title, content, 'engineer')
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

  // Wrap substantive responses as a generic artifact
  const looksLikeDeliverable = /```|^#{1,3}\s|\b(openapi|paths:|components:|architecture)\b/im.test(
    rawText,
  )
  if (looksLikeDeliverable && rawText.trim()) {
    const containsSourceCode =
      /```(?:typescript|ts|tsx|javascript|js|jsx|css|html|python|py|shell|bash|sh|rust|go|java|sql|vue|svelte)\b/i.test(
        rawText,
      )
    const kind = expectedArtifact ?? (containsSourceCode ? 'application' : 'specification')
    return {
      text: `Created **${kind}** for review.`,
      nodes: [
        {
          type: kind,
          category: 'output',
          title: 'Generated artifact',
          content: rawText,
          status: 'proposed',
          artifact: coerceArtifactEnvelope(kind, 'Generated artifact', rawText, 'engineer'),
        },
      ],
    }
  }

  return { text: rawText, nodes: [] }
}
