import { Enclave } from '@enclave-vm/core'
import type { PapyrusAgentFSFilesystem } from './workspace-agentfs.js'
import { WorkspaceExecutorRegistry, assertWorkspacePath } from './workspace-executors.js'

const MAX_PROGRAM_BYTES = 128 * 1024
const MAX_TEXT_READ_BYTES = 256 * 1024
const MAX_TEXT_WRITE_BYTES = 512 * 1024

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

export class PapyrusEnclaveRuntime {
  constructor(
    private readonly filesystem: PapyrusAgentFSFilesystem,
    private readonly executors: WorkspaceExecutorRegistry,
  ) {}

  async run(code: string): Promise<AgentScriptResult> {
    if (typeof code !== 'string' || !code.trim()) throw new Error('AgentScript code is required')
    if (Buffer.byteLength(code) > MAX_PROGRAM_BYTES) throw new Error('AgentScript program exceeds 128 KiB')

    const enclave = new Enclave({
      securityLevel: 'STRICT',
      preset: 'agentscript',
      timeout: 15_000,
      memoryLimit: 16 * 1024 * 1024,
      maxToolCalls: 32,
      maxIterations: 2_500,
      allowBuiltins: false,
      sanitizeStackTraces: true,
      sidecar: {
        enabled: true,
        extractionThreshold: 16 * 1024,
        maxTotalSize: 4 * 1024 * 1024,
        maxReferenceSize: 2 * 1024 * 1024,
        maxResolvedSize: 2 * 1024 * 1024,
        maxReferenceCount: 64,
        allowComposites: false,
      },
      scoringGate: {
        scorer: 'rule-based',
        blockThreshold: 70,
        warnThreshold: 40,
      },
      toolHandler: async (name, args) => this.callTool(name, args),
    })

    try {
      const result = await enclave.run(code)
      return {
        kind: 'agentscript_result',
        success: result.success,
        ...(result.success ? { value: result.value } : {}),
        ...(result.error ? { error: {
          name: result.error.name,
          message: result.error.message,
          ...(result.error.code ? { code: result.error.code } : {}),
        } } : {}),
        stats: {
          duration: result.stats.duration,
          toolCallCount: result.stats.toolCallCount,
          iterationCount: result.stats.iterationCount,
          ...(result.stats.memoryUsage !== undefined ? { memoryUsage: result.stats.memoryUsage } : {}),
        },
      }
    } finally {
      enclave.dispose()
    }
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
      case 'process:python':
        return this.executors.runPython({
          scriptPath: requiredString(args['scriptPath'], 'scriptPath'),
          ...(stringArray(args['args']) ? { args: stringArray(args['args']) } : {}),
          ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
        })
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
    return this.filesystem.readdir(path, {
      recursive,
      maxDepth: recursive ? 4 : 1,
    })
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

function readPath(args: Record<string, unknown>): string {
  return assertReadablePath(requiredString(args['path'], 'path'))
}

function assertReadablePath(value: string): string {
  const path = assertWorkspacePath(value)
  if (
    path !== '/Workspace' && !path.startsWith('/Workspace/') &&
    path !== '/Library' && !path.startsWith('/Library/')
  ) throw new Error('AgentScript may only read /Workspace and /Library')
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
