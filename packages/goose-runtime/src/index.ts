import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeLaunchOptions,
  RuntimePromptRequest,
  RuntimePromptResult,
} from '@papyrus/acp-runtime'

export const GOOSE_RUNTIME_KIND = 'goose' as const
export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION

/** Header carrying the per-runtime model environment over the authenticated channel. */
export const RUNTIME_CONFIG_HEADER = 'x-papyrus-runtime-config'

export type GooseHealth = RuntimeHealth
export type GoosePromptEvent = RuntimeEvent
export type GoosePromptRequest = RuntimePromptRequest
export type GoosePromptResult = RuntimePromptResult
export interface GooseRuntimeOptions extends RuntimeLaunchOptions {}

export const GOOSE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  transports: ['stdio', 'streamable-http'],
  sessions: { cancel: true, load: false, resume: false, fork: false },
}

export class GooseRuntime implements AgentRuntime {
  readonly kind = GOOSE_RUNTIME_KIND
  readonly capabilities = GOOSE_RUNTIME_CAPABILITIES
  readonly command: string
  readonly args: string[]
  readonly endpoint: string | undefined
  private readonly baseEnvironment: Record<string, string>
  private readonly startupTimeoutMs: number
  private readonly promptTimeoutMs: number | undefined
  private readonly headers: Record<string, string>
  private readonly fetch: typeof globalThis.fetch | undefined

  constructor(options: GooseRuntimeOptions = {}) {
    this.command = options.command ?? 'goose'
    this.args = options.args ?? ['acp']
    this.endpoint = options.endpoint
    this.baseEnvironment = options.baseEnvironment ?? {}
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
    this.promptTimeoutMs = options.promptTimeoutMs
    this.headers = options.headers ?? {}
    this.fetch = options.fetch
  }

  async health(): Promise<GooseHealth> {
    if (this.endpoint) return this.remoteHealth()
    return this.childHealth()
  }

  private async remoteHealth(): Promise<GooseHealth> {
    try {
      const url = `${this.endpoint!.replace(/\/$/, '')}/health`
      const response = await (this.fetch ?? globalThis.fetch)(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.startupTimeoutMs),
      })
      if (!response.ok) return { available: false, reason: `worker health returned ${response.status}` }
      return { available: true, version: 'remote-worker' }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : 'worker health check failed' }
    }
  }

  private childHealth(): Promise<GooseHealth> {
    return new Promise((resolve) => {
      const process = spawn(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        process.kill('SIGKILL')
        resolve({ available: false, reason: 'goose version check timed out' })
      }, this.startupTimeoutMs)
      process.stdout.on('data', (chunk) => { stdout += String(chunk) })
      process.stderr.on('data', (chunk) => { stderr += String(chunk) })
      process.once('error', (error) => {
        clearTimeout(timer)
        resolve({ available: false, reason: error.message })
      })
      process.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve({ available: true, version: stdout.trim() || stderr.trim() })
        else resolve({ available: false, reason: stderr.trim() || `goose exited with ${code}` })
      })
    })
  }

  async runPrompt(request: GoosePromptRequest): Promise<GoosePromptResult> {
    const controller = new AbortController()
    const timeout = this.promptTimeoutMs ? setTimeout(() => controller.abort(new Error('prompt timeout')), this.promptTimeoutMs) : undefined
    const onRequestAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onRequestAbort, { once: true })
    try {
      if (this.endpoint) return await this.runRemote(request, controller.signal)
      return await this.runChild(request, controller.signal)
    } finally {
      if (timeout) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onRequestAbort)
    }
  }

  private async runChild(request: GoosePromptRequest, abort: AbortSignal): Promise<GoosePromptResult> {
    const child = this.spawn(request.environment)
    const onAbort = () => child.kill('SIGTERM')
    abort.addEventListener('abort', onAbort, { once: true })
    const stderr = this.forwardStderr(child, request.onEvent)
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    try {
      return await this.runSession(stream, request)
    } finally {
      abort.removeEventListener('abort', onAbort)
      child.kill('SIGTERM')
      await Promise.race([stderr, new Promise<void>((resolve) => setTimeout(resolve, 500))])
    }
  }

  private async runRemote(request: GoosePromptRequest, abort: AbortSignal): Promise<GoosePromptResult> {
    const headers: Record<string, string> = { ...this.headers }
    const config = encodeRuntimeConfig(request.environment)
    if (config) headers[RUNTIME_CONFIG_HEADER] = config
    const stream = createHttpStream(this.endpoint as string, {
      headers,
      ...(this.fetch ? { fetch: this.fetch } : {}),
    })
    const onAbort = () => { void stream.readable.cancel().catch(() => {}) }
    abort.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.runSession(stream, request)
    } finally {
      abort.removeEventListener('abort', onAbort)
    }
  }

  private async runSession(stream: acp.Stream, request: GoosePromptRequest): Promise<GoosePromptResult> {
    const client = acp.client({ name: 'papyrus' })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const allowed = await request.authorizeTool(params.toolCall.title ?? 'unknown-tool')
        const desired = allowed ? 'allow_once' : 'reject_once'
        const option = params.options.find((candidate) => candidate.kind === desired)
        return option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      })

    return await client.connectWith(stream, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const builder = context.buildSession({
        cwd: request.cwd,
        mcpServers: (request.mcpServers ?? []).map((server) => ({
          type: 'http' as const,
          name: server.name,
          url: server.url,
          headers: server.headers ?? [],
        })),
      })
      return builder.withSession(async (session) => {
        await request.onEvent({ kind: 'session', at: new Date().toISOString(), data: { runtimeSessionId: session.sessionId } })
        void session.prompt(request.prompt)
        for (;;) {
          const message = await session.nextUpdate()
          if (message.kind === 'stop') {
            await request.onEvent({ kind: 'complete', at: new Date().toISOString(), data: message.response })
            return { runtimeSessionId: session.sessionId, stopReason: message.stopReason }
          }
          await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: message.update })
        }
      })
    })
  }

  private spawn(environment: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    return spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.baseEnvironment, ...environment },
    })
  }

  private async forwardStderr(child: ChildProcessWithoutNullStreams, onEvent: GoosePromptRequest['onEvent']): Promise<void> {
    for await (const chunk of child.stderr) {
      await onEvent({ kind: 'stderr', at: new Date().toISOString(), data: String(chunk).slice(0, 4_096) })
    }
  }
}

export function encodeRuntimeConfig(env: Record<string, string> | undefined): string | undefined {
  if (!env || Object.keys(env).length === 0) return undefined
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64url')
}
