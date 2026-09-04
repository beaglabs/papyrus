import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { PapyrusAgentFSFilesystem } from './workspace-agentfs.js'
import { WorkspaceExecutorRegistry, assertWorkspacePath } from './workspace-executors.js'

const MAX_PROGRAM_BYTES = 128 * 1024
const MAX_TEXT_READ_BYTES = 256 * 1024
const MAX_TEXT_WRITE_BYTES = 512 * 1024
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024
const WORKER_JS_PATH = fileURLToPath(new URL('./workspace-enclave-worker.js', import.meta.url))
const WORKER_TS_PATH = fileURLToPath(new URL('./workspace-enclave-worker.ts', import.meta.url))

export interface AgentScriptResult {
  kind: 'agentscript_result'
  success: boolean
  value?: unknown
  error?: {
    name: string
    message: string
    code?: string
  }
  stats: {
    duration: number
    toolCallCount: number
    iterationCount: number
    memoryUsage?: number
  }
}

interface WorkerToolCall {
  type: 'tool_call'
  id: string
  name: string
  args: Record<string, unknown>
}
interface WorkerResult { type: 'result'; result: AgentScriptResult }
interface WorkerError { type: 'worker_error'; error: string }
type WorkerMessage = WorkerToolCall | WorkerResult | WorkerError

/**
 * Enclave is intentionally hosted in a child process that is itself wrapped
 * by nono-ts. A future Enclave regression therefore reaches only the isolated
 * worker, not the Papyrus daemon, AgentFS database, credentials, or network.
 */
export class PapyrusEnclaveRuntime {
  private readonly dataDir: string

  constructor(
    private readonly filesystem: PapyrusAgentFSFilesystem,
    private readonly executors: WorkspaceExecutorRegistry,
    dataDir: string,
  ) {
    this.dataDir = resolve(dataDir)
  }

  async run(code: string): Promise<AgentScriptResult> {
    if (typeof code !== 'string' || !code.trim()) throw new Error('AgentScript code is required')
    if (Buffer.byteLength(code) > MAX_PROGRAM_BYTES) throw new Error('AgentScript program exceeds 128 KiB')

    const runRoot = join(this.dataDir, '.enclave-runs', randomUUID())
    mkdirSync(runRoot, { recursive: true, mode: 0o700 })

    try {
      return await this.executeWorker(code, runRoot)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  }

  private executeWorker(code: string, runRoot: string): Promise<AgentScriptResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, workerArguments(), {
        cwd: dirname(workerSourcePath()),
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          LANG: process.env.LANG ?? 'C.UTF-8',
          HOME: runRoot,
          TMPDIR: runRoot,
          PAPYRUS_ENCLAVE_TEMP: runRoot,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const output = createInterface({ input: child.stdout, crlfDelay: Infinity })
      let result: AgentScriptResult | undefined
      let protocolBytes = 0
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        stderr += '\n[papyrus-enclave] Worker exceeded 20 second parent timeout'
        child.kill('SIGKILL')
      }, 20_000)
      timer.unref?.()

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (value: string) => {
        if (Buffer.byteLength(stderr) < 64 * 1024) stderr += value.slice(0, 64 * 1024)
      })

      output.on('line', (line) => {
        protocolBytes += Buffer.byteLength(line)
        if (protocolBytes > MAX_PROTOCOL_BYTES) {
          child.kill('SIGKILL')
          return
        }

        let packet: WorkerMessage
        try {
          packet = JSON.parse(line) as WorkerMessage
        } catch {
          stderr += '\n[papyrus-enclave] Worker emitted malformed protocol data'
          child.kill('SIGKILL')
          return
        }

        if (packet.type === 'result') {
          result = packet.result
          return
        }
        if (packet.type === 'worker_error') {
          stderr += `\n[papyrus-enclave] ${packet.error}`
          return
        }
        if (packet.type === 'tool_call') {
          void this.handleToolCall(packet).then(
            (value) => writePacket(child, { type: 'tool_result', id: packet.id, success: true, value }),
            (error) => writePacket(child, {
              type: 'tool_result',
              id: packet.id,
              success: false,
              error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
            }),
          )
        }
      })

      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })

      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        output.close()
        if (result) return resolvePromise(result)
        reject(new Error(
          `Enclave worker exited without a result (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})${stderr.trim() ? `: ${stderr.trim().slice(0, 4000)}` : ''}`,
        ))
      })

      writePacket(child, { type: 'run', code })
    })
  }

  private async handleToolCall(packet: WorkerToolCall): Promise<unknown> {
    return this.callTool(packet.name, isRecord(packet.args) ? packet.args : {})
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'workspace:list':
        return this.list(args)
      case 'workspace:stat':
        return this.filesystem.stat(readPath(args))
      case 'workspace:readText':
        return this.readText(args)
      case 'workspace:writeText':
        return this.writeText(args)
      case 'process:python': {
        const pythonArgs = stringArray(args['args'])
        return this.executors.runPython({
          scriptPath: requiredString(args['scriptPath'], 'scriptPath'),
          ...(pythonArgs ? { args: pythonArgs } : {}),
          ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
        })
      }
      case 'process:pandoc':
        return this.executors.runPandoc({
          inputPath: requiredString(args['inputPath'], 'inputPath'),
          outputPath: requiredString(args['outputPath'], 'outputPath'),
          ...(typeof args['from'] === 'string' ? { from: args['from'] } : {}),
          ...(typeof args['to'] === 'string' ? { to: args['to'] } : {}),
        })
      case 'process:libreoffice': {
        const outputFormat = requiredString(args['outputFormat'], 'outputFormat')
        if (!['pdf', 'docx', 'xlsx', 'pptx', 'html', 'txt'].includes(outputFormat)) throw new Error('Unsupported LibreOffice output format')
        return this.executors.runLibreOffice({
          inputPath: requiredString(args['inputPath'], 'inputPath'),
          outputFormat: outputFormat as 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'txt',
          ...(typeof args['outputDir'] === 'string' ? { outputDir: args['outputDir'] } : {}),
        })
      }
      case 'process:ffmpeg':
        return this.executors.runFfmpeg({
          inputPaths: requiredStringArray(args['inputPaths'], 'inputPaths'),
          outputPath: requiredString(args['outputPath'], 'outputPath'),
          ...(oneOf(args['videoCodec'], ['copy', 'libx264', 'libx265', 'vp9']) ? { videoCodec: args['videoCodec'] as 'copy' | 'libx264' | 'libx265' | 'vp9' } : {}),
          ...(oneOf(args['audioCodec'], ['copy', 'aac', 'opus']) ? { audioCodec: args['audioCodec'] as 'copy' | 'aac' | 'opus' } : {}),
          ...(typeof args['startSeconds'] === 'number' ? { startSeconds: args['startSeconds'] } : {}),
          ...(typeof args['durationSeconds'] === 'number' ? { durationSeconds: args['durationSeconds'] } : {}),
          ...(typeof args['overwrite'] === 'boolean' ? { overwrite: args['overwrite'] } : {}),
        })
      case 'process:remotion':
        return this.executors.runRemotion({
          projectDir: requiredString(args['projectDir'], 'projectDir'),
          composition: requiredString(args['composition'], 'composition'),
          outputPath: requiredString(args['outputPath'], 'outputPath'),
          ...(isRecord(args['props']) ? { props: args['props'] } : {}),
        })
      default:
        throw new Error(`AgentScript tool ${name} is not allowed`)
    }
  }

  private async list(args: Record<string, unknown>) {
    const path = typeof args['path'] === 'string' ? assertReadablePath(args['path']) : '/Workspace'
    const recursive = args['recursive'] === true
    return this.filesystem.readdir(path, { recursive, maxDepth: recursive ? 4 : 1 })
  }

  private async readText(args: Record<string, unknown>): Promise<{ path: string; text: string }> {
    const path = readPath(args)
    const stat = await this.filesystem.stat(path)
    if (stat.type !== 'file') throw new Error('workspace:readText requires a file')
    if (stat.size > MAX_TEXT_READ_BYTES) throw new Error('workspace:readText is limited to 256 KiB; use a constrained process tool for larger files')
    const value = await this.filesystem.readFile(path, { encoding: 'utf8' })
    return { path, text: String(value) }
  }

  private async writeText(args: Record<string, unknown>): Promise<{ path: string; bytes: number }> {
    const path = assertEnclaveWritablePath(requiredString(args['path'], 'path'))
    const content = requiredString(args['content'], 'content', true)
    const bytes = Buffer.byteLength(content)
    if (bytes > MAX_TEXT_WRITE_BYTES) throw new Error('workspace:writeText is limited to 512 KiB')
    await this.filesystem.writeFile(path, content, { recursive: true, overwrite: true })
    return { path, bytes }
  }
}

function workerArguments(): string[] {
  if (existsSync(WORKER_JS_PATH)) return [WORKER_JS_PATH]
  if (existsSync(WORKER_TS_PATH)) return ['--import', import.meta.resolve('tsx'), WORKER_TS_PATH]
  throw new Error('Papyrus Enclave worker is missing from this build')
}

function workerSourcePath(): string {
  if (existsSync(WORKER_JS_PATH)) return WORKER_JS_PATH
  if (existsSync(WORKER_TS_PATH)) return WORKER_TS_PATH
  throw new Error('Papyrus Enclave worker is missing from this build')
}

function writePacket(child: ReturnType<typeof spawn>, value: unknown): void {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed) return
  stdin.write(JSON.stringify(value) + '\n')
}

function readPath(args: Record<string, unknown>): string {
  return assertReadablePath(requiredString(args['path'], 'path'))
}

function assertReadablePath(value: string): string {
  const path = assertWorkspacePath(value)
  if (path !== '/Workspace' && !path.startsWith('/Workspace/') && path !== '/Library' && !path.startsWith('/Library/')) {
    throw new Error('AgentScript may only read /Workspace and /Library')
  }
  return path
}

function assertEnclaveWritablePath(value: string): string {
  const path = assertWorkspacePath(value)
  if (
    path !== '/Workspace' && !path.startsWith('/Workspace/') &&
    path !== '/Library/Generated' && !path.startsWith('/Library/Generated/')
  ) throw new Error('AgentScript writes are limited to /Workspace and /Library/Generated')
  return path
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label} is required`)
  if (Buffer.byteLength(value) > 512 * 1024) throw new Error(`${label} is too large`)
  if (value.includes('\u0000')) throw new Error(`${label} may not contain NUL bytes`)
  return value
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  return requiredStringArray(value, 'args')
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} must be an array of strings`)
  if (value.length > 32) throw new Error(`${label} has too many entries`)
  return value as string[]
}

function oneOf(value: unknown, choices: string[]): boolean {
  return typeof value === 'string' && choices.includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
