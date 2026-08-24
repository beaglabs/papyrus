import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

// Non-workspace tools. Files, commands, search, skills, LSP, and browser access
// come from the session-scoped Mastra Workspace.
export function buildStaticAgentTools() {
  const generateImage = createTool({
    id: 'papyrus_generate',
    description: 'Generate an image from a text prompt. Returns image as base64-encoded PNG. Only works when the upstream provider exposes an OpenAI-compatible /images/generations endpoint.',
    inputSchema: z.object({
      prompt: z.string().describe('Image generation prompt'),
      imageModel: z.string().default('gpt-image-1'),
      size: z.enum(['1024x1024', '1792x1024', '1024x1792']).default('1024x1024'),
      quality: z.enum(['low', 'medium', 'high']).default('medium'),
    }),
    execute: async ({ prompt: imgPrompt, imageModel, size, quality }, context) => {
      const model = context?.requestContext?.get('upstreamModel') as { endpoint: string; apiKey?: string } | undefined
      const endpoint = (model?.endpoint ?? 'https://api.openai.com').replace(/\/$/, '')
      const url = endpoint.endsWith('/v1') ? `${endpoint}/images/generations` : `${endpoint}/v1/images/generations`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(model?.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: imageModel, prompt: imgPrompt, size, quality, n: 1, response_format: 'b64_json' }),
        signal: AbortSignal.timeout(60000),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Image generation failed (${response.status}): ${body.slice(0, 256)}`)
      }
      const data = await response.json() as { data?: Array<{ b64_json?: string }> }
      const b64 = data.data?.[0]?.b64_json
      if (!b64) throw new Error('No image data returned')
      return { type: 'image', data: b64, mimeType: 'image/png' }
    },
  })

  // Elicit: ask the user structured input via Mastra's `suspend()` mechanism.
  // When the agent calls this tool, the stream emits a `tool-call-suspended`
  // chunk; the user's response is delivered back via `useChat`'s resume path.
  const requestInput = createTool({
    id: 'papyrus_request_input',
    description: 'Request structured input from the authenticated user when required to continue. Pauses execution until the user responds.',
    inputSchema: z.object({
      message: z.string().describe('Message shown to the user explaining what is needed'),
    }),
    suspendSchema: z.object({
      message: z.string(),
    }),
    resumeSchema: z.object({
      response: z.record(z.string(), z.unknown()),
    }),
    execute: async ({ message }, context) => {
      const elicit = context?.requestContext?.get('elicit') as ((request: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined
      if (!elicit) throw new Error('Interactive input is unavailable')
      return await elicit({ message, requestedSchema: { type: 'object', properties: { response: { type: 'string', title: 'Response' } }, required: ['response'] } })
    },
  })

  return {
    papyrus_generate: generateImage,
    papyrus_request_input: requestInput,
  }
}

// Build the per-session toolset. These tools route through PapyrusService's
// MCP and source dispatchers. Every invocation is approved through Papyrus'
// durable approval lifecycle before the governed callback executes it.
export function buildSessionToolset(
  toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
) {
  const tools: Record<string, ReturnType<typeof createTool>> = {}
  for (const def of toolDefs) {
    tools[def.name] = createTool({
      id: def.name,
      description: def.description,
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (args, context) => {
        const invoke = context?.requestContext?.get('invokeTool') as ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined
        const authorize = context?.requestContext?.get('authorizeTool') as ((title: string) => Promise<boolean>) | undefined
        if (!invoke) throw new Error('Governed tool execution is unavailable')
        if (!authorize || !await authorize(def.name)) throw new Error(`User denied ${def.name}`)
        return await invoke(def.name, args as Record<string, unknown>)
      },
    }) as never
  }
  return tools
}
