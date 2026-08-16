import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

export const GOOSE_RUNTIME_KIND = 'goose' as const
export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION

export interface GooseHealth {
  available: boolean
  version?: string
  reason?: string
}

export interface GoosePromptEvent {
  kind: 'session' | 'update' | 'complete' | 'stderr'
  at: string
  data: unknown
}

export interface GoosePromptRequest {
  cwd: string
  prompt: string
  environment?: Record<string, string>
  mcpServers?: Array<{ name: string; url: string; headers?: Array<{ name: string; value: string }> }>
  authorizeTool: (title: string) => Promise<boolean>
  onEvent: (event: GoosePromptEvent) => void | Promise<void>
}

export interface GoosePromptResult {
  runtimeSessionId: string
  stopReason: string
}

export interface GooseRuntimeOptions {
  command?: string
  args?: string[]
  baseEnvironment?: Record<string, string>
  startupTimeoutMs?: number
}

export class GooseRuntime {
  readonly command: string
  readonly args: string[]
  private readonly baseEnvironment: Record<string, string>
  private readonly startupTimeoutMs: number

  constructor(options: GooseRuntimeOptions = {}) {
    this.command = options.command ?? 'goose'
    this.args = options.args ?? ['acp']
    this.baseEnvironment = options.baseEnvironment ?? {}
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
  }

  async health(): Promise<GooseHealth> {
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
    const child = this.spawn(request.environment)
    const stderr = this.forwardStderr(child, request.onEvent)
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )

    const client = acp.client({ name: 'papyrus' })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        const allowed = await request.authorizeTool(params.toolCall.title ?? 'unknown-tool')
        const desired = allowed ? 'allow_once' : 'reject_once'
        const option = params.options.find((candidate) => candidate.kind === desired)
        return option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      })

    try {
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
    } finally {
      child.kill('SIGTERM')
      await Promise.race([stderr, new Promise<void>((resolve) => setTimeout(resolve, 500))])
    }
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
