import * as acp from '@agentclientprotocol/sdk'

export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION

export type RuntimeTransport = 'stdio' | 'streamable-http' | 'websocket'

export interface RuntimeCapabilities {
  transports: readonly RuntimeTransport[]
  sessions: {
    cancel: boolean
    load: boolean
    resume: boolean
    fork: boolean
  }
}

export interface RuntimeHealth {
  available: boolean
  version?: string
  reason?: string
}

export type RuntimeEventKind = 'session' | 'update' | 'complete' | 'stderr'

export interface RuntimeEvent {
  kind: RuntimeEventKind
  at: string
  data: unknown
}

export interface RuntimeMcpServer {
  name: string
  url: string
  headers?: Array<{ name: string; value: string }>
}

export interface RuntimePromptRequest {
  cwd: string
  prompt: string | acp.ContentBlock[]
  environment?: Record<string, string>
  mcpServers?: RuntimeMcpServer[]
  authorizeTool: (title: string) => Promise<boolean>
  elicit?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  onEvent: (event: RuntimeEvent) => void | Promise<void>
  signal?: AbortSignal
}

export interface RuntimePromptResult {
  runtimeSessionId: string
  stopReason: string
}

export interface RuntimeLaunchOptions {
  command?: string
  args?: string[]
  baseEnvironment?: Record<string, string>
  startupTimeoutMs?: number
  promptTimeoutMs?: number
  endpoint?: string
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch | undefined
}

export interface RuntimeLaunchSpec {
  kind: string
  command: string
  args: string[]
  environment(): Record<string, string>
}

export interface AgentRuntime {
  readonly kind: string
  readonly capabilities: RuntimeCapabilities
  health(): Promise<RuntimeHealth>
  runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult>
}

export interface RuntimeAdapter {
  readonly kind: string
  create(options?: RuntimeLaunchOptions): AgentRuntime
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>()

  constructor(adapters: Iterable<RuntimeAdapter> = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: RuntimeAdapter): this {
    const kind = adapter.kind.trim()
    if (!kind) throw new Error('Runtime adapter kind is required')
    if (this.adapters.has(kind)) throw new Error(`Runtime adapter "${kind}" is already registered`)
    this.adapters.set(kind, adapter)
    return this
  }

  has(kind: string): boolean {
    return this.adapters.has(kind)
  }

  kinds(): string[] {
    return [...this.adapters.keys()].sort()
  }

  create(kind: string, options: RuntimeLaunchOptions = {}): AgentRuntime {
    const adapter = this.adapters.get(kind)
    if (!adapter) throw new Error(`Unknown runtime adapter "${kind}"`)
    const runtime = adapter.create(options)
    if (runtime.kind !== kind) {
      throw new Error(`Runtime adapter "${kind}" created mismatched runtime "${runtime.kind}"`)
    }
    return runtime
  }
}

export { runAcpPrompt } from './session.js'
export {
  RuntimeProcessExitError,
  STDIO_RUNTIME_CAPABILITIES,
  StdioAcpRuntime,
  type RuntimeProcessExit,
  type StdioRuntimeOptions,
} from './stdio.js'
