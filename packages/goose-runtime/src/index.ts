import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import {
  ACP_PROTOCOL_VERSION,
  StdioAcpRuntime,
  runAcpPrompt,
  type AgentRuntime,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeHealth,
  type RuntimeLaunchOptions,
  type RuntimePromptRequest,
  type RuntimePromptResult,
} from '@papyrus/acp-runtime'

export const GOOSE_RUNTIME_KIND = 'goose' as const
export { ACP_PROTOCOL_VERSION }

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

  private readonly localRuntime: StdioAcpRuntime
  private readonly startupTimeoutMs: number
  private readonly promptTimeoutMs: number | undefined
  private readonly headers: Record<string, string>
  private readonly fetch: typeof globalThis.fetch | undefined

  constructor(options: GooseRuntimeOptions = {}) {
    this.command = options.command ?? 'goose'
    this.args = options.args ?? ['acp']
    this.endpoint = options.endpoint
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
    this.promptTimeoutMs = options.promptTimeoutMs
    this.headers = options.headers ?? {}
    this.fetch = options.fetch
    this.localRuntime = new StdioAcpRuntime({
      ...options,
      kind: GOOSE_RUNTIME_KIND,
      command: this.command,
      args: this.args,
      versionArgs: ['--version'],
    })
  }

  health(): Promise<GooseHealth> {
    if (!this.endpoint) return this.localRuntime.health()
    return this.remoteHealth()
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
      return {
        available: false,
        reason: error instanceof Error ? error.message : 'worker health check failed',
      }
    }
  }

  async runPrompt(request: GoosePromptRequest): Promise<GoosePromptResult> {
    if (!this.endpoint) return await this.localRuntime.runPrompt(request)

    const controller = new AbortController()
    const timeout = this.promptTimeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new Error('goose prompt timed out')), this.promptTimeoutMs)
    const onRequestAbort = (): void => controller.abort(
      request.signal?.reason instanceof Error
        ? request.signal.reason
        : new Error('goose prompt was cancelled'),
    )
    request.signal?.addEventListener('abort', onRequestAbort, { once: true })

    try {
      return await this.runRemote(request, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        throw reason instanceof Error ? reason : new Error('goose prompt was cancelled')
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onRequestAbort)
    }
  }

  private async runRemote(
    request: GoosePromptRequest,
    abort: AbortSignal,
  ): Promise<GoosePromptResult> {
    const headers: Record<string, string> = { ...this.headers }
    const config = encodeRuntimeConfig(request.environment)
    if (config) headers[RUNTIME_CONFIG_HEADER] = config

    const stream = createHttpStream(this.endpoint as string, {
      headers,
      ...(this.fetch ? { fetch: this.fetch } : {}),
    })
    const onAbort = (): void => {
      void stream.readable.cancel().catch(() => {})
    }
    abort.addEventListener('abort', onAbort, { once: true })

    try {
      return await runAcpPrompt(stream, request)
    } finally {
      abort.removeEventListener('abort', onAbort)
    }
  }
}

export const gooseRuntimeAdapter: RuntimeAdapter = {
  kind: GOOSE_RUNTIME_KIND,
  create(options: RuntimeLaunchOptions = {}) {
    return new GooseRuntime(options)
  },
}

export function encodeRuntimeConfig(env: Record<string, string> | undefined): string | undefined {
  if (!env || Object.keys(env).length === 0) return undefined
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64url')
}
