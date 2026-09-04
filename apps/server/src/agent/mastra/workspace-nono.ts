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
const WORKER_JS_PATH = fileURLToPath(new URL('./workspace-nono-worker.js', import.meta.url))
const WORKER_TS_PATH = fileURLToPath(new URL('./workspace-nono-worker.ts', import.meta.url))

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
  private readonly dataDir: string
  private executionTail: Promise<void> = Promise.resolve()

  constructor(options: { filesystem: PapyrusAgentFSFilesystem; dataDir: string }) {
    super()
    this.filesystem = options.filesystem
    this.dataDir = resolve(options.dataDir)
  }

  async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    if (!command.trim()) throw new Error('Workspace command is required')
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error('Workspace command exceeds 64 KiB')

    const releaseLease = await this.acquireExecutionLease()
    let materialized: MaterializedWorkspace | undefined
    let controlPath: string | undefined

    try {
      materialized = await this.filesystem.materializeForExecution()
      const cwd = normalizeWorkspaceCwd(options.cwd ?? '/')
      const hostCwd = materializedPath(materialized.root, cwd)
      if (!existsSync(hostCwd)) throw new Error(`Workspace cwd does not exist: ${cwd}`)

      const home = join(materialized.root, '.papyrus-home')
      const temp = join(materialized.root, '.papyrus-tmp')
      mkdirSync(home, { recursive: true, mode: 0o700 })
      mkdirSync(temp, { recursive: true, mode: 0o700 })

      const controlDirectory = join(this.dataDir, '.workspace-control')
      mkdirSync(controlDirectory, { recursive: true, mode: 0o700 })
      controlPath = join(controlDirectory, `${randomUUID()}.json`)
      writeFileSync(controlPath, JSON.stringify({
        workspaceRoot: materialized.root,
        cwd,
        command,
        env: workspaceEnvironment(materialized.root, options.env),
      }), { mode: 0o600, flag: 'wx' })

      const startedAt = Date.now()
      const child = spawn(process.execPath, workerArguments(controlPath), {
        cwd: this.dataDir,
        env: workerBootstrapEnvironment(this.dataDir),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      let handle!: NonoProcessHandle
      handle = new NonoProcessHandle(child, startedAt, options, async (exitCode) => {
        let finalCode = exitCode
        try {
          await this.filesystem.reconcileExecution(materialized!)
        } catch (error) {
          handle.emitStderr(`\n[papyrus-workspace] Unable to reconcile command output into AgentFS: ${message(error)}\n`)
          finalCode = finalCode === 0 ? 70 : finalCode
        } finally {
          this.filesystem.cleanupExecution(materialized!)
          if (controlPath) rmSync(controlPath, { force: true })
          releaseLease()
        }
        return finalCode
      })
      this._tracked.set(handle.pid, handle)
      return handle
    } catch (error) {
      if (materialized) this.filesystem.cleanupExecution(materialized)
      if (controlPath) rmSync(controlPath, { force: true })
      releaseLease()
      throw error
    }
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
    await Promise.all(handles.map((handle) => handle.wait().catch(() => undefined)))
    for (const handle of handles) this.release(handle.pid)
  }

  private async acquireExecutionLease(): Promise<() => void> {
    const previous = this.executionTail
    let release!: () => void
    this.executionTail = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
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

  constructor(child: ChildProcessWithoutNullStreams, startedAt: number, options: SpawnProcessOptions, finalize: (exitCode: number) => Promise<number>) {
    super(options)
    this.child = child
    this.startedAt = startedAt
    this.pid = String(child.pid ?? randomUUID())

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (value: string) => this.emitStdout(value))
    child.stderr.on('data', (value: string) => this.emitStderr(value))

    this.completion = new Promise((resolvePromise, reject) => {
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        if (this.timeout) clearTimeout(this.timeout)
        this.emitStderr(`[papyrus-workspace] Worker failed to start: ${error.message}\n`)
        void finalize(70).then((finalCode) => {
          this._exitCode = finalCode
          resolvePromise({
            success: false,
            exitCode: finalCode,
            stdout: this.stdout,
            stderr: this.stderr,
            executionTimeMs: Date.now() - this.startedAt,
          })
        }, reject)
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        if (this.timeout) clearTimeout(this.timeout)
        const processCode = code ?? (signal ? 128 : 1)
        void finalize(processCode).then((finalCode) => {
          this._exitCode = finalCode
          resolvePromise({
            success: finalCode === 0,
            exitCode: finalCode,
            stdout: this.stdout,
            stderr: this.stderr,
            executionTimeMs: Date.now() - this.startedAt,
            ...(this._timedOut ? { timedOut: true } : {}),
            ...(this._killed ? { killed: true } : {}),
          })
        }, reject)
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

export function normalizeWorkspaceCwd(value: string): string {
  const raw = value.trim() || '/'
  const normalized = posix.normalize(raw.startsWith('/') ? raw : `/${raw}`)
  if (normalized === '/..' || normalized.startsWith('/../')) throw new Error('Sandbox cwd escapes AgentFS workspace')
  return normalized
}

function workerArguments(controlPath: string): string[] {
  if (existsSync(WORKER_JS_PATH)) return [WORKER_JS_PATH, controlPath]
  if (existsSync(WORKER_TS_PATH)) {
    // pnpm dev executes the source tree through tsx. Resolve the exact loader
    // from this trusted module rather than relying on PATH.
    return ['--import', import.meta.resolve('tsx'), WORKER_TS_PATH, controlPath]
  }
  throw new Error('Papyrus workspace executor worker is missing from this build')
}
function materializedPath(root: string, virtualPath: string): string {
  const normalized = normalizeWorkspaceCwd(virtualPath)
  const target = resolve(root, normalized.replace(/^\/+/, ''))
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Sandbox path escapes materialized workspace')
  return target
}

export function workspaceEnvironment(root: string, overlay: Record<string, string | undefined> = {}): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: join(root, '.papyrus-home'),
    TMPDIR: join(root, '.papyrus-tmp'),
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined || sensitiveEnvironmentKey(key)) continue
    environment[key] = value
  }
  return environment
}

function workerBootstrapEnvironment(dataDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: join(dataDir, '.workspace-worker-home'),
    TMPDIR: join(dataDir, '.workspace-worker-tmp'),
  }
}

function sensitiveEnvironmentKey(key: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i.test(key)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
