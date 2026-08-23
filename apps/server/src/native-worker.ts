import type { ContentBlock } from '@agentclientprotocol/sdk'
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimePromptRequest,
  RuntimePromptResult,
  RuntimeTool,
} from '@papyrus/acp-runtime'
import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'

export interface PapyrusWorkerConfig {
  endpoint?: string
  model?: string
  apiKey?: string
  promptTimeoutMs?: number
  cwd?: string
}

export const PAPYRUS_WORKER_CAPABILITIES: RuntimeCapabilities = {
  transports: ['streamable-http'],
  sessions: { cancel: true, load: true, resume: true, fork: false },
}

/**
 * Papyrus's in-process worker. The daemon owns identity, policy, durable state,
 * credentials and tools; the model endpoint receives only the governed turn.
 */
export class PapyrusWorker implements AgentRuntime {
  readonly kind = 'papyrus'
  readonly capabilities = PAPYRUS_WORKER_CAPABILITIES

  constructor(private readonly config: PapyrusWorkerConfig) {}

  async health(): Promise<RuntimeHealth> {
    if (!this.config.endpoint || !this.config.model) {
      return { available: false, reason: 'Papyrus model endpoint is not configured' }
    }
    return { available: true, version: 'native' }
  }

  private resolvePath(requestedPath: string): string {
    const base = this.config.cwd ?? process.cwd()
    const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(base, requestedPath)
    if (!absolute.startsWith(resolve(base))) throw new Error('Path traversal not allowed')
    return absolute
  }

  private async readFileTool(args: Record<string, unknown>): Promise<unknown> {
    const path = this.resolvePath(String(args.path))
    const encoding = (args.encoding as string) ?? 'utf-8'
    const content = await fs.readFile(path, encoding as BufferEncoding)
    const mimeType = path.endsWith('.py') ? 'text/x-python'
      : path.endsWith('.js') || path.endsWith('.ts') ? 'text/javascript'
      : path.endsWith('.json') ? 'application/json'
      : path.endsWith('.md') ? 'text/markdown'
      : 'text/plain'
    return { type: 'resource', resource: { uri: `file://${path}`, mimeType, text: content } }
  }

  private async writeFileTool(args: Record<string, unknown>): Promise<unknown> {
    const path = this.resolvePath(String(args.path))
    const content = String(args.content ?? '')
    await fs.mkdir(resolve(path, '..'), { recursive: true })
    await fs.writeFile(path, content, 'utf-8')
    return { type: 'text', text: `Wrote ${content.length} bytes to ${path}` }
  }

  private async listFilesTool(args: Record<string, unknown>): Promise<unknown> {
    const dir = this.resolvePath(String(args.path ?? '.'))
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const items = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
      path: relative(this.config.cwd ?? process.cwd(), resolve(dir, e.name)),
    }))
    return { type: 'text', text: JSON.stringify(items, null, 2) }
  }

  private async globTool(args: Record<string, unknown>): Promise<unknown> {
    const pattern = String(args.pattern)
    const base = this.config.cwd ?? process.cwd()
    const { glob } = await import('node:fs/promises')
    const matches: string[] = []
    for await (const match of glob(pattern, { cwd: base })) {
      matches.push(resolve(base, match))
    }
    return { type: 'text', text: JSON.stringify(matches, null, 2) }
  }

  private async execCodeTool(args: Record<string, unknown>, onOutput?: (stream: 'stdout' | 'stderr', text: string) => Promise<void>): Promise<unknown> {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    await SandboxManager.initialize({} as any)
    
    const code = String(args.code)
    const language = (args.language as string) ?? 'python'
    const timeoutMs = Number(args.timeoutMs ?? 30000)
    
    let command: string
    if (language === 'python') {
      command = `python3 -c ${JSON.stringify(code)}`
    } else if (language === 'javascript' || language === 'typescript') {
      command = `node -e ${JSON.stringify(code)}`
    } else {
      throw new Error(`Unsupported language: ${language}`)
    }
    
    const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, { timeoutMs } as any)
    const result = await this.runWrappedCommand(wrapped, onOutput)
    
    return { type: 'text', text: result }
  }

  private async runWrappedCommand(wrappedCommand: string, onOutput?: (stream: 'stdout' | 'stderr', text: string) => Promise<void>): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', wrappedCommand], { timeout: 60000 })
      let stdout = '', stderr = ''
      let outputQueue = Promise.resolve()
      const report = (stream: 'stdout' | 'stderr', text: string) => {
        outputQueue = outputQueue.then(async () => { await onOutput?.(stream, text) })
      }
      child.stdout.on('data', d => { const text = d.toString(); stdout += text; report('stdout', text) })
      child.stderr.on('data', d => { const text = d.toString(); stderr += text; report('stderr', text) })
      child.on('close', code => {
        void outputQueue.then(() => {
          if (code === 0) resolve(stdout || 'OK')
          else reject(new Error(stderr || `Exit code ${code}`))
        }, reject)
      })
      child.on('error', reject)
    })
  }

  private async generateImageTool(args: Record<string, unknown>): Promise<unknown> {
    const prompt = String(args.prompt)
    const model = (args.model as string) ?? 'gpt-image-1'
    const size = (args.size as string) ?? '1024x1024'
    const quality = (args.quality as string) ?? 'medium'
    
    const endpoint = this.config.endpoint!.replace(/\/$/, '')
    const response = await fetch(`${endpoint}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, prompt, size, quality, n: 1, response_format: 'b64_json' }),
      signal: AbortSignal.timeout(60000),
    })
    
    if (!response.ok) throw new Error(`Image generation failed: ${response.status}`)
    const data = await response.json() as { data?: Array<{ b64_json?: string; revised_prompt?: string }> }
    const b64 = data.data?.[0]?.b64_json
    if (!b64) throw new Error('No image data returned')
    
    return { type: 'image', data: b64, mimeType: 'image/png' }
  }


  async runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult> {
    if (!this.config.endpoint || !this.config.model) {
      throw new Error('Configure PAPYRUS_MODEL_ENDPOINT and PAPYRUS_MODEL before starting a session')
    }

    const runtimeSessionId = crypto.randomUUID()
    await request.onEvent({
      kind: 'session',
      at: new Date().toISOString(),
      data: { runtimeSessionId },
    })

    const messages: ModelMessage[] = [
      {
        role: 'system',
        content: 'You are the Papyrus governed worker. Use the supplied tools to complete tasks. Built-in tools: papyrus_read_file, papyrus_write_file, papyrus_list_files, papyrus_glob for filesystem access; papyrus_exec_code for sandboxed code execution (Python/JS); papyrus_generate for image generation; papyrus_request_input for user clarification. Never claim an action completed unless its tool result confirms it.',
      },
      { role: 'user', content: promptContent(request.prompt) },
    ]
    const tools = [
      ...(request.tools ?? []).map(modelTool),
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_read_file',
          description: 'Read a file from the workspace. Returns file content as a resource.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path to file (relative to workspace root or absolute)' },
              encoding: { type: 'string', enum: ['utf-8', 'base64'], default: 'utf-8' },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_write_file',
          description: 'Write content to a file in the workspace. Creates parent directories if needed.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path to file (relative to workspace root or absolute)' },
              content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_list_files',
          description: 'List files and directories in a workspace path.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory path (relative to workspace root)', default: '.' },
            },
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_glob',
          description: 'Find files matching a glob pattern in the workspace.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.py")' },
            },
            required: ['pattern'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_exec_code',
          description: 'Execute code in a secure sandbox (Python, JavaScript, TypeScript). Returns stdout, stderr, and any generated files/images as resources.',
          parameters: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Code to execute' },
              language: { type: 'string', enum: ['python', 'javascript', 'typescript'], default: 'python' },
              timeoutMs: { type: 'number', default: 30000 },
            },
            required: ['code'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_generate',
          description: 'Generate an image from a text prompt. Returns image as base64-encoded PNG.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Image generation prompt' },
              model: { type: 'string', default: 'gpt-image-1' },
              size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024' },
              quality: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
            },
            required: ['prompt'],
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'papyrus_request_input',
          description: 'Request structured input from the authenticated user when required to continue.',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              requestedSchema: { type: 'object' },
            },
            required: ['message'],
          },
        },
      },
    ]

    for (let turn = 0; turn < 32; turn += 1) {
      if (request.signal?.aborted) return { runtimeSessionId, stopReason: 'cancelled' }
      const message = await this.complete(messages, tools, request.signal)
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) {
        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
            messageId: `agent_${runtimeSessionId}_${turn}`,
          },
        })
      }

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        await request.onEvent({
          kind: 'complete',
          at: new Date().toISOString(),
          data: { stopReason: 'end_turn' },
        })
        return { runtimeSessionId, stopReason: 'end_turn' }
      }

      messages.push(message)
      for (const call of calls) {
        const name = call.function.name
        const args = parseArguments(call.function.arguments)
        const toolKind = name === 'papyrus_exec_code' ? 'execute'
          : name.includes('read') || name.includes('list') || name.includes('glob') ? 'read'
          : name.includes('write') ? 'edit'
          : 'other'
        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: { sessionUpdate: 'tool_call', toolCallId: call.id, title: name, kind: toolKind, status: 'pending' },
        })
        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: { sessionUpdate: 'tool_call_update', toolCallId: call.id, title: name, kind: toolKind, status: 'in_progress' },
        })

        let result: unknown
        let liveOutput = ''
        try {
          if (name === 'papyrus_read_file') {
            result = await this.readFileTool(args)
          } else if (name === 'papyrus_write_file') {
            result = await this.writeFileTool(args)
          } else if (name === 'papyrus_list_files') {
            result = await this.listFilesTool(args)
          } else if (name === 'papyrus_glob') {
            result = await this.globTool(args)
          } else if (name === 'papyrus_exec_code') {
            result = await this.execCodeTool(args, async (stream, text) => {
              liveOutput += stream === 'stderr' ? `[stderr] ${text}` : text
              await request.onEvent({
                kind: 'update',
                at: new Date().toISOString(),
                data: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: call.id,
                  title: name,
                  kind: toolKind,
                  status: 'in_progress',
                  content: [{ type: 'content', content: { type: 'text', text: liveOutput } }],
                },
              })
            })
          } else if (name === 'papyrus_generate') {
            result = await this.generateImageTool(args)
          } else if (name === 'papyrus_request_input') {
            if (!request.elicit) throw new Error('Interactive input is unavailable')
            result = await request.elicit({
              message: typeof args.message === 'string' ? args.message : 'The worker needs more information.',
              requestedSchema: isRecord(args.requestedSchema) ? args.requestedSchema : {
                type: 'object',
                properties: { response: { type: 'string', title: 'Response' } },
                required: ['response'],
              },
            })
          } else {
            const allowed = await request.authorizeTool(name)
            if (!allowed) throw new Error('Tool request denied by policy or user approval')
            if (!request.invokeTool) throw new Error('Governed tool execution is unavailable')
            result = await request.invokeTool(name, args)
          }
          await request.onEvent({
            kind: 'update',
            at: new Date().toISOString(),
            data: {
              sessionUpdate: 'tool_call_update',
              toolCallId: call.id,
              title: name,
              kind: toolKind,
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: safeJson(result) } }],
            },
          })
        } catch (error) {
          result = { error: error instanceof Error ? error.message : 'Tool execution failed' }
          await request.onEvent({
            kind: 'update',
            at: new Date().toISOString(),
            data: {
              sessionUpdate: 'tool_call_update',
              toolCallId: call.id,
              title: name,
              kind: toolKind,
              status: 'failed',
              content: [{ type: 'content', content: { type: 'text', text: safeJson(result) } }],
            },
          })
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: safeJson(result) })
      }
    }

    await request.onEvent({
      kind: 'complete',
      at: new Date().toISOString(),
      data: { stopReason: 'max_turn_requests' },
    })
    return { runtimeSessionId, stopReason: 'max_turn_requests' }
  }

  private async complete(messages: ModelMessage[], tools: ModelTool[], signal?: AbortSignal): Promise<ModelMessage> {
    const endpoint = this.config.endpoint!.replace(/\/$/, '')
    const timeout = AbortSignal.timeout(this.config.promptTimeoutMs ?? 600_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: combined,
    })
    if (!response.ok) throw new Error(`Model endpoint returned ${response.status}: ${(await response.text()).slice(0, 1024)}`)
    const body = await response.json() as { choices?: Array<{ message?: ModelMessage }> }
    const message = body.choices?.[0]?.message
    if (!message) throw new Error('Model endpoint returned no assistant message')
    return message
  }
}

type ModelTool = {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}
type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function modelTool(tool: RuntimeTool): ModelTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    },
  }
}

function promptContent(prompt: string | ContentBlock[]): string | Array<Record<string, unknown>> {
  if (typeof prompt === 'string') return prompt
  const content: Array<Record<string, unknown>> = []
  for (const block of prompt) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'image') content.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
    else if (block.type === 'resource') {
      const resource = block.resource
      if ('text' in resource) content.push({ type: 'text', text: `Attached resource ${resource.uri}:\n${resource.text}` })
      else content.push({ type: 'text', text: `Attached resource ${resource.uri} (${resource.mimeType}, base64):\n${resource.blob}` })
    }
  }
  return content.length ? content : ''
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch { return {} }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return JSON.stringify({ error: 'Tool result was not serializable' }) }
}