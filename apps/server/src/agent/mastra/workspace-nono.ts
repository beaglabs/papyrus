import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, posix, resolve, sep } from 'node:path'
import { isSupported, supportInfo } from 'nono-ts'
import {
  MastraSandbox,
  ProcessHandle,
  SandboxProcessManager,
  type CommandResult,
  type ProcessInfo,
  type ProviderStatus,
  type SandboxInfo,
  type SpawnProcessOptions,
} from '@mastra/core/workspace'
import { type MaterializedWorkspace, type PapyrusAgentFSFilesystem } from './workspace-agentfs.js'

export interface NonoWorkspaceSandboxOptions {
  filesystem: PapyrusAgentFSFilesystem
  dataDir: string
  platform?: NodeJS.Platform
}

const MAX_COMMAND_BYTES = 64 * 1024
const WORKER_PATH = fileURLToPath(new URL('./workspace-nono-worker.js', import.meta.url))

export class NonoWorkspaceSandbox extends MastraSandbox {
  readonly id = 'papyrus-nono'
  readonly name = 'Papyrus Nono Sandbox'
  readonly provider = 'nono-ts'
  readonly supportsCheckpoints = false
  readonly workingDirectory = '/'
  status: ProviderStatus = 'pending'

  readonly filesystem: PapyrusAgentFSFilesystem
  readonly dataDir: string
  readonly platform: NodeJS.Platform

  constructor(options: NonoWorkspaceSandboxOptions) {
    const manager = new NonoProcessManager({
      filesystem: options.filesystem,
      dataDir: options.dataDir,
    })
    super({ name: 'Papyrus Nono Sandbox', processes: manager })
    this.filesystem = options.filesystem
    this.dataDir = resolve(options.dataDir)
    this.platform = options.platform ?? process.platform
  }

  async start(): Promise<void> {
    if (!['linux', 'darwin'].includes(this.platform)) {
      throw new Error(`nono-ts workspace sandbox requires Linux or macOS; ${this.platform} is unsupported`)
    }
    if (!isSupported()) {
      const info = supportInfo()
      throw new Error(`nono-ts sandbox is unavailable on ${info.platform}: ${info.details}`)
    }
    mkdirSync(join(this.dataDir, '.workspace-control'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.dataDir, '.workspace-exec'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.dataDir, '.workspace-worker-home'), { recursive: true, mode: 0o700 })
    mkdirSync(join(this.dataDir, '.workspace-worker-tmp'), { recursive: true, mode: 0o700 })
  }

  async stop(): Promise<void> {
    const manager = this.processes as NonoProcessManager | undefined
    if (manager) await manager.killTracked()
  }

  async destroy(): Promise<void> {
    const manager = this.processes as NonoProcessManager | undefined
    if (manager) await manager.killTracked()
  }

  getInstructions(): string {
    return [
      'Workspace files persist directly in the local AgentFS SDK SQLite database.',
      'When a real OS command is required, Papyrus materializes a bounded snapshot into a private execution directory.',
      'A dedicated nono-ts worker applies kernel isolation before spawning the command.',
      'Outbound network is blocked; the user home directory and Papyrus data directory are not granted.',
      'Command changes are reconciled back into AgentFS only after the process exits.',
      'External side effects still require Papyrus action executors.',
    ].join(' ')
  }

  getInfo(): SandboxInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: new Date(),
      metadata: {
        isolation: this.platform === 'darwin' ? 'seatbelt-via-nono-ts' : 'landlock-via-nono-ts',
        filesystem: 'agentfs-sdk',
        storage: 'local-sqlite',
        execution: 'materialize-sandbox-reconcile',
        network: 'blocked',
      },
    }
  }
}

class NonoProcessManager extends SandboxProcessManager<NonoWorkspaceSandbox> {
  private readonly filesystem: PapyrusAgentFSFilesystem
  private readonly nonoBinary: string
  private readonly dataDir: string

  constructor(options: { filesystem: PapyrusAgentFSFilesystem; nonoBinary: string; dataDir: string }) {
    super()
    this.filesystem = options.filesystem
    this.nonoBinary = options.nonoBinary
    this.dataDir = options.dataDir
  }

  async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    const plan = buildNonoLaunchPlan(this.filesystem, this.nonoBinary, command, options.cwd ?? '/')
    const environment = minimalEnvironment(this.dataDir, options.env)
    const startedAt = Date.now()
    const child = spawn(plan.binary, plan.args, {
      cwd: this.dataDir,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const handle = new NonoProcessHandle(child, startedAt, options)
    this._tracked.set(handle.pid, handle)
    return handle
  }

  async list(): Promise<ProcessInfo[]> {
    return [...this._tracked.values()].map((handle) => ({
      pid: handle.pid,
      ...(handle.command ? { command: handle.command } : {}),
      running: handle.exitCode === undefined,
      ...(handle.exitCode !== undefined ? { exitCode: handle.exitCode } : {}),
    }))
  }

  async killTracked(): Promise<void> {
    const handles = [...this._tracked.values()]
    await Promise.all(handles.filter((handle) => handle.exitCode === undefined).map((handle) => handle.kill().catch(() => false)))
    for (const handle of handles) this.release(handle.pid)
  }
}

class NonoProcessHandle extends ProcessHandle {
  readonly pid: string
  private readonly child: ChildProcessWithoutNullStreams
  private readonly startedAt: number
  private _exitCode: number | undefined
  private _killed = false
  private _timedOut = false
  private readonly completion: Promise<CommandResult>
  private timeout: ReturnType<typeof setTimeout> | undefined

  constructor(child: ChildProcessWithoutNullStreams, startedAt: number, options: SpawnProcessOptions) {
    super(options)
    this.child = child
    this.startedAt = startedAt
    this.pid = String(child.pid ?? crypto.randomUUID())

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => this.emitStdout(value))
    child.stderr.on('data', (value: string) => this.emitStderr(value))

    this.completion = new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (this.timeout) clearTimeout(this.timeout)
        this._exitCode = code ?? (signal ? 128 : 1)
        resolvePromise({
          success: this._exitCode === 0,
          exitCode: this._exitCode,
          stdout: this.stdout,
          stderr: this.stderr,
          executionTimeMs: Date.now() - this.startedAt,
          ...(this._timedOut ? { timedOut: true } : {}),
          ...(this._killed ? { killed: true } : {}),
        })
      })
    })

    if (options.timeout && options.timeout > 0) {
      this.timeout = setTimeout(() => {
        this._timedOut = true
        void this.kill()
      }, options.timeout)
      this.timeout.unref?.()
    }
  }

  get exitCode(): number | undefined {
    return this._exitCode
  }

  async kill(): Promise<boolean> {
    if (this._exitCode !== undefined) return false
    this._killed = true
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL')
      else this.child.kill('SIGKILL')
      return true
    } catch {
      return this.child.kill('SIGKILL')
    }
  }

  async sendStdin(data: string): Promise<void> {
    if (this._exitCode !== undefined || this.child.stdin.destroyed) throw new Error('Process stdin is closed')
    await new Promise<void>((resolvePromise, reject) => {
      this.child.stdin.write(data, (error) => error ? reject(error) : resolvePromise())
    })
  }

  async closeStdin(): Promise<void> {
    if (!this.child.stdin.destroyed) this.child.stdin.end()
  }

  async wait(): Promise<CommandResult> {
    return this.completion
  }
}

function normalizeWorkspaceCwd(value: string): string {
  const raw = value.trim() || '/'
  const normalized = posix.normalize(raw.startsWith('/') ? raw : `/${raw}`)
  if (normalized === '/..' || normalized.startsWith('/../')) throw new Error('Sandbox cwd escapes AgentFS workspace')
  return normalized
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
