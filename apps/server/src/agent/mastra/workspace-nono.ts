import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, posix } from 'node:path'
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
import { minimalEnvironment, runBinary, type PapyrusAgentFSFilesystem } from './workspace-agentfs.js'

export interface NonoWorkspaceSandboxOptions {
  filesystem: PapyrusAgentFSFilesystem
  binary?: string
  dataDir: string
  platform?: NodeJS.Platform
}

export interface NonoLaunchPlan {
  binary: string
  args: string[]
  backend: 'fuse' | 'nfs'
}

/**
 * Build the exact local execution chain:
 *
 * AgentFS transient mount -> nono least-privilege sandbox -> command.
 *
 * AgentFS chooses FUSE on Linux and NFS on macOS. nono independently selects
 * Landlock on Linux and Seatbelt on macOS, so Papyrus does not reimplement
 * either OS sandbox profile.
 */
export function buildNonoLaunchPlan(
  filesystem: PapyrusAgentFSFilesystem,
  nonoBinary: string,
  command: string,
  cwd = '/',
): NonoLaunchPlan {
  const normalizedCwd = normalizeWorkspaceCwd(cwd)
  const shellCommand = `cd -- ${shellQuote(normalizedCwd)} && exec /bin/sh -lc ${shellQuote(command)}`
  return {
    binary: filesystem.binary,
    backend: filesystem.mountBackend,
    args: [
      'exec',
      '--backend', filesystem.mountBackend,
      filesystem.databasePath,
      nonoBinary,
      'run',
      '--allow-cwd',
      '--block-net',
      '--',
      '/bin/sh',
      '-lc',
      shellCommand,
    ],
  }
}

export class NonoWorkspaceSandbox extends MastraSandbox {
  readonly id = 'papyrus-nono'
  readonly name = 'Papyrus Nono Sandbox'
  readonly provider = 'nono'
  readonly supportsCheckpoints = false
  readonly workingDirectory = '/'
  status: ProviderStatus = 'pending'

  readonly filesystem: PapyrusAgentFSFilesystem
  readonly nonoBinary: string
  readonly dataDir: string
  readonly platform: NodeJS.Platform

  constructor(options: NonoWorkspaceSandboxOptions) {
    const manager = new NonoProcessManager({
      filesystem: options.filesystem,
      nonoBinary: options.binary ?? 'nono',
      dataDir: options.dataDir,
    })
    super({ name: 'Papyrus Nono Sandbox', processes: manager })
    this.filesystem = options.filesystem
    this.nonoBinary = options.binary ?? 'nono'
    this.dataDir = options.dataDir
    this.platform = options.platform ?? process.platform
  }

  async start(): Promise<void> {
    if (!['linux', 'darwin'].includes(this.platform)) {
      throw new Error(`nono workspace sandbox requires Linux or macOS; ${this.platform} is unsupported`)
    }
    mkdirSync(join(this.dataDir, '.workspace-home'), { recursive: true, mode: 0o700 })
    const nono = await runBinary(this.nonoBinary, ['--version'], { cwd: this.dataDir })
    if (nono.exitCode !== 0) throw new Error(`nono preflight failed: ${nono.stderr.toString('utf8').slice(0, 1000)}`)
    await this.filesystem._init()
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
      'Commands execute locally inside the AgentFS workspace through nono.',
      `AgentFS uses ${this.filesystem.mountBackend.toUpperCase()} for the transient local mount on this host.`,
      'nono grants the mounted workspace read/write access and blocks outbound network by default.',
      'Host credentials, SSH keys, cloud config, and the rest of the host filesystem are not exposed to commands.',
      'Use workspace-relative paths. External side effects still require Papyrus action executors.',
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
        isolation: this.platform === 'darwin' ? 'seatbelt-via-nono' : 'landlock-via-nono',
        filesystem: 'agentfs',
        agentfsMountBackend: this.filesystem.mountBackend,
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
