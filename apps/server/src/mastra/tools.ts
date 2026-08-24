import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'

// Built-in agent tools that don't require approval. Session-scoped state
// (cwd, model config) flows through `requestContext`, populated per-prompt by
// the MastraAgentWorker. The agent can call these freely; the runtime loop
// surfaces them in the stream and invokes `execute` synchronously.
export function buildStaticAgentTools() {
  const readFile = createTool({
    id: 'papyrus_read_file',
    description: 'Read a file from the workspace. Returns file content as a resource.',
    inputSchema: z.object({
      path: z.string().describe('Path to file (relative to workspace root or absolute)'),
      encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
    }),
    execute: async ({ path, encoding }, context) => {
      const cwd = String(context?.requestContext?.get('cwd') ?? process.cwd())
      const absolute = resolvePath(cwd, path)
      const content = await fs.readFile(absolute, encoding as BufferEncoding)
      const mimeType = absolute.endsWith('.py') ? 'text/x-python'
        : absolute.endsWith('.js') || absolute.endsWith('.ts') ? 'text/javascript'
        : absolute.endsWith('.json') ? 'application/json'
        : absolute.endsWith('.md') ? 'text/markdown'
        : 'text/plain'
      return { type: 'resource', resource: { uri: `file://${absolute}`, mimeType, text: content } }
    },
  })

  const writeFile = createTool({
    id: 'papyrus_write_file',
    description: 'Write content to a file in the workspace. Creates parent directories if needed.',
    inputSchema: z.object({
      path: z.string().describe('Path to file (relative to workspace root or absolute)'),
      content: z.string().describe('File content to write'),
    }),
    execute: async ({ path, content }, context) => {
      const cwd = String(context?.requestContext?.get('cwd') ?? process.cwd())
      const absolute = resolvePath(cwd, path)
      await fs.mkdir(resolve(absolute, '..'), { recursive: true })
      await fs.writeFile(absolute, content, 'utf-8')
      return { type: 'resource', resource: { uri: `file://${absolute}`, mimeType: 'text/plain', text: content } }
    },
  })

  const listFiles = createTool({
    id: 'papyrus_list_files',
    description: 'List files and directories in a workspace path.',
    inputSchema: z.object({
      path: z.string().default('.').describe('Directory path (relative to workspace root)'),
    }),
    execute: async ({ path }, context) => {
      const cwd = String(context?.requestContext?.get('cwd') ?? process.cwd())
      const dir = resolvePath(cwd, path)
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const items = entries.map((e) => ({
        name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
        path: relative(cwd, resolve(dir, e.name)),
      }))
      return { type: 'text', text: JSON.stringify(items, null, 2) }
    },
  })

  const glob = createTool({
    id: 'papyrus_glob',
    description: 'Find files matching a glob pattern in the workspace.',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.py")'),
    }),
    execute: async ({ pattern }, context) => {
      const cwd = String(context?.requestContext?.get('cwd') ?? process.cwd())
      const matches: string[] = []
      for await (const match of fs.glob(pattern, { cwd })) {
        matches.push(resolve(cwd, match))
      }
      return { type: 'text', text: JSON.stringify(matches, null, 2) }
    },
  })

  const execCode = createTool({
    id: 'papyrus_exec_code',
    description: 'Execute code in a secure sandbox (Python, JavaScript, TypeScript). Returns stdout, stderr, and any generated files/images as resources.',
    inputSchema: z.object({
      code: z.string().describe('Code to execute'),
      language: z.enum(['python', 'javascript', 'typescript']).default('python'),
      timeoutMs: z.number().default(30000),
    }),
    execute: async ({ code, language, timeoutMs }) => {
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
      await SandboxManager.initialize({} as never)
      const cmd = language === 'python' ? `python3 -c ${JSON.stringify(code)}`
        : language === 'javascript' || language === 'typescript' ? `node -e ${JSON.stringify(code)}`
        : (() => { throw new Error(`Unsupported language: ${language}`) })()
      const wrapped = await SandboxManager.wrapWithSandbox(cmd, undefined, { timeoutMs } as never)
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn('sh', ['-c', wrapped], { timeout: 60000 })
        let stdout = '', stderr = ''
        child.stdout.on('data', (d) => { stdout += d.toString() })
        child.stderr.on('data', (d) => { stderr += d.toString() })
        child.on('close', (code) => { if (code === 0) resolve(stdout || 'OK'); else reject(new Error(stderr || `Exit code ${code}`)) })
        child.on('error', reject)
      })
      return { type: 'text', text: result }
    },
  })

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
      const agent = context?.agent
      if (!agent?.suspend) throw new Error('Interactive input is unavailable')
      return await agent.suspend({ message })
    },
  })

  return {
    papyrus_read_file: readFile,
    papyrus_write_file: writeFile,
    papyrus_list_files: listFiles,
    papyrus_glob: glob,
    papyrus_exec_code: execCode,
    papyrus_generate: generateImage,
    papyrus_request_input: requestInput,
  }
}

// Build the per-session toolset. These tools route through PapyrusService's
// MCP and source dispatchers and require explicit user approval before each
// invocation. The runtime loop surfaces approval requests as `tool-call-approval`
// chunks; `useChat.approveToolCall` resumes execution.
export function buildSessionToolset(
  toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
) {
  const tools: Record<string, ReturnType<typeof createTool>> = {}
  for (const def of toolDefs) {
    tools[def.name] = createTool({
      id: def.name,
      description: def.description,
      inputSchema: z.record(z.string(), z.unknown()),
      requireApproval: true,
      execute: async (args, context) => {
        const invoke = context?.requestContext?.get('invokeTool') as ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined
        if (!invoke) throw new Error('Governed tool execution is unavailable')
        return await invoke(def.name, args as Record<string, unknown>)
      },
    }) as never
  }
  return tools
}

function resolvePath(cwd: string, requestedPath: string): string {
  const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath)
  if (!absolute.startsWith(resolve(cwd))) throw new Error('Path traversal not allowed')
  return absolute
}