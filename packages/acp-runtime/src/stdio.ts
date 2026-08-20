import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimeLaunchOptions,
  RuntimePromptRequest,
  RuntimePromptResult,
} from './index.js'
import { runAcpPrompt } from './session.js'

export interface StdioRuntimeOptions extends RuntimeLaunchOptions {
  kind?: string
  versionArgs?: string[]
  shutdownGraceMs?: number
  stderrLimitBytes?: number
}

export interface RuntimeProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export class RuntimeProcessExitError extends Error {
  constructor(
    readonly runtimeKind: string,
    readonly exit: RuntimeProcessExit,
  ) {
    super(
      `${runtimeKind} runtime exited before completing the ACP turn ` +
      `(code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'})`,
    )
    this.name = 'RuntimeProcessExitError'
  }
}

export const STDIO_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  transports: ['stdio'],
  sessions: { cancel: true, load: false, resume: false, fork: false },
}

export class StdioAcpRuntime implements AgentRuntime {
  readonly kind: string
  readonly capabilities = STDIO_RUNTIME_CAPABILITIES
  readonly command: string
  readonly args: string[]

  private readonly versionArgs: string[]
  private readonly baseEnvironment: Record<string, string>
  private readonly startupTimeoutMs: number
  private readonly promptTimeoutMs: number | undefined
  private readonly shutdownGraceMs: number
  private readonly stderrLimitBytes: number

  constructor(options: StdioRuntimeOptions = {}) {
    this.kind = options.kind?.trim() || 'stdio-acp'
    this.command = options.command ?? this.kind
    this.args = options.args ?? ['acp']
    this.versionArgs = options.versionArgs ?? ['--version']
    this.baseEnvironment = options.baseEnvironment ?? {}
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000
    this.promptTimeoutMs = options.promptTimeoutMs
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000
    this.stderrLimitBytes = options.stderrLimitBytes ?? 16_384
  }

  health(): Promise<RuntimeHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.command, this.versionArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.baseEnvironment },
      })
      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (health: RuntimeHealth): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(health)
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ available: false, reason: `${this.kind} version check timed out` })
      }, this.startupTimeoutMs)

      child.stdout.on('data', (chunk) => {
        if (stdout.length < 4_096) stdout += String(chunk).slice(0, 4_096 - stdout.length)
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4_096) stderr += String(chunk).slice(0, 4_096 - stderr.length)
      })
      child.once('error', (error) => finish({ available: false, reason: error.message }))
      child.once('exit', (code, signal) => {
        if (code === 0) finish({ available: true, version: stdout.trim() || stderr.trim() })
        else finish({
          available: false,
          reason: stderr.trim() || `${this.kind} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
        })
      })
    })
  }

  async runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult> {
    const controller = new AbortController()
    const timeout = this.promptTimeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new Error(`${this.kind} prompt timed out`)), this.promptTimeoutMs)
    const onRequestAbort = (): void => controller.abort(
      request.signal?.reason instanceof Error
        ? request.signal.reason
        : new Error(`${this.kind} prompt was cancelled`),
    )
    request.signal?.addEventListener('abort', onRequestAbort, { once: true })
    if (request.signal?.aborted) onRequestAbort()

    const child = this.spawn(request.environment)
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const stderr = this.forwardStderr(child, request.onEvent)
    const exitResult = new Promise<RuntimeProcessExit>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const exited: Promise<never> = exitResult.then((exit) => {
      throw new RuntimeProcessExitError(this.kind, exit)
    })
    let stopping: Promise<void> | undefined
    const stop = (): Promise<void> => stopping ??= this.terminate(child)
    const onAbort = (): void => {
      void stop()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()

    try {
      return await Promise.race([
        runAcpPrompt(stream, request),
        exited,
      ])
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        throw reason instanceof Error ? reason : new Error(`${this.kind} prompt was cancelled`)
      }

      // Stream closure can win the event-loop race with the child exit event.
      // Briefly correlate the two so callers receive the actionable exit code.
      const exit = child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : await Promise.race([
            exitResult,
            delay(100).then(() => undefined),
          ])
      if (exit) throw new RuntimeProcessExitError(this.kind, exit)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onRequestAbort)
      controller.signal.removeEventListener('abort', onAbort)
      await stop()
      await Promise.race([stderr.catch(() => {}), delay(250)])
    }
  }

  private spawn(environment: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    return spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.baseEnvironment, ...environment },
    })
  }

  private async forwardStderr(
    child: ChildProcessWithoutNullStreams,
    onEvent: RuntimePromptRequest['onEvent'],
  ): Promise<void> {
    let remaining = this.stderrLimitBytes
    for await (const chunk of child.stderr) {
      if (remaining <= 0) continue
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const limited = bytes.subarray(0, remaining)
      remaining -= limited.byteLength
      await onEvent({
        kind: 'stderr',
        at: new Date().toISOString(),
        data: limited.toString('utf8'),
      })
    }
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return

    child.kill('SIGTERM')
    await Promise.race([waitForExit(child), delay(this.shutdownGraceMs)])
    if (child.exitCode !== null || child.signalCode !== null) return

    child.kill('SIGKILL')
    await Promise.race([waitForExit(child), delay(this.shutdownGraceMs)])
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
