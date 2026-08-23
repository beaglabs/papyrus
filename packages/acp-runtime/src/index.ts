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

export interface RuntimeTool {
  name: string
  description?: string
  requiresApproval?: boolean
  inputSchema: Record<string, unknown>
}

export interface RuntimePromptRequest {
  cwd: string
  prompt: string | acp.ContentBlock[]
  environment?: Record<string, string>
  tools?: RuntimeTool[]
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
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

export interface AgentRuntime {
  readonly kind: string
  readonly capabilities: RuntimeCapabilities
  health(): Promise<RuntimeHealth>
  runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult>
}
