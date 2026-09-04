import { posix } from 'node:path'
import type { CommandResult } from '@mastra/core/workspace'
import type { NonoWorkspaceSandbox } from './workspace-nono.js'

export type WorkspaceProcessKind = 'python' | 'pandoc' | 'libreoffice' | 'ffmpeg' | 'remotion'

export interface WorkspaceProcessResult {
  kind: 'workspace_process_result'
  executor: WorkspaceProcessKind
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  executionTimeMs: number
}

const MAX_ARGS = 64
const MAX_ARG_BYTES = 16 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024

export class WorkspaceExecutorRegistry {
  constructor(private readonly sandbox: NonoWorkspaceSandbox) {}

  async runPython(input: { scriptPath: string; args?: string[]; cwd?: string }): Promise<WorkspaceProcessResult> {
    const script = processPath(input.scriptPath)
    if (!script.toLowerCase().endsWith('.py')) throw new Error('runPython requires a .py script inside the workspace')
    return this.execute('python', 'python3', [script, ...safeArgs(input.args)], input.cwd ?? '/', 120_000)
  }

  async runPandoc(input: { inputPath: string; outputPath: string; from?: string; to?: string }): Promise<WorkspaceProcessResult> {
    const source = processPath(input.inputPath)
    const target = processPath(assertWritableOutput(input.outputPath))
    const args = [source, '-o', target]
    if (input.from) args.push('--from', safeFormat(input.from))
    if (input.to) args.push('--to', safeFormat(input.to))
    return this.execute('pandoc', 'pandoc', args, '/', 120_000)
  }

  async runLibreOffice(input: { inputPath: string; outputDir?: string; outputFormat: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'txt' }): Promise<WorkspaceProcessResult> {
    const source = processPath(input.inputPath)
    const outputDir = processPath(assertWritableDirectory(input.outputDir ?? '/Library/Generated'))
    return this.execute('libreoffice', 'libreoffice', [
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--convert-to',
      input.outputFormat,
      '--outdir',
      outputDir,
      source,
    ], '/', 180_000)
  }

  async runFfmpeg(input: {
    inputPaths: string[]
    outputPath: string
    videoCodec?: 'copy' | 'libx264' | 'libx265' | 'vp9'
    audioCodec?: 'copy' | 'aac' | 'opus'
    startSeconds?: number
    durationSeconds?: number
    overwrite?: boolean
  }): Promise<WorkspaceProcessResult> {
    if (!Array.isArray(input.inputPaths) || input.inputPaths.length < 1 || input.inputPaths.length > 8) {
      throw new Error('runFfmpeg requires between one and eight workspace inputs')
    }
    const args: string[] = []
    if (input.overwrite !== false) args.push('-y')
    if (input.startSeconds !== undefined) args.push('-ss', boundedNumber(input.startSeconds, 0, 86_400, 'startSeconds'))
    for (const path of input.inputPaths) args.push('-i', processPath(path))
    if (input.durationSeconds !== undefined) args.push('-t', boundedNumber(input.durationSeconds, 0.01, 86_400, 'durationSeconds'))
    if (input.videoCodec) args.push('-c:v', input.videoCodec)
    if (input.audioCodec) args.push('-c:a', input.audioCodec)
    args.push(processPath(assertWritableOutput(input.outputPath)))
    return this.execute('ffmpeg', 'ffmpeg', args, '/', 300_000)
  }

  async runRemotion(input: {
    projectDir: string
    composition: string
    outputPath: string
    props?: Record<string, unknown>
  }): Promise<WorkspaceProcessResult> {
    const project = processPath(assertWorkspacePath(input.projectDir))
    const output = processPath(assertWritableOutput(input.outputPath))
    const composition = boundedText(input.composition, 200, 'composition')
    const args = ['--dir', project, 'exec', 'remotion', 'render', composition, output]
    if (input.props && Object.keys(input.props).length) {
      const serialized = JSON.stringify(input.props)
      if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('Remotion props exceed 64 KiB')
      args.push('--props', serialized)
    }
    return this.execute('remotion', 'pnpm', args, '/', 600_000)
  }

  private async execute(kind: WorkspaceProcessKind, command: string, args: string[], cwd: string, timeout: number): Promise<WorkspaceProcessResult> {
    if (!this.sandbox.executeCommand) throw new Error('Workspace process execution is unavailable')
    await this.sandbox.ensureRunning()
    validateArguments(args)
    const result = await this.sandbox.executeCommand(command, args, {
      cwd: assertWorkspacePath(cwd),
      timeout,
      maxRetainedBytes: MAX_OUTPUT_BYTES,
    })
    return normalizeResult(kind, result)
  }
}

function normalizeResult(executor: WorkspaceProcessKind, result: CommandResult): WorkspaceProcessResult {
  return {
    kind: 'workspace_process_result',
    executor,
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionTimeMs: result.executionTimeMs,
  }
}

function validateArguments(args: string[]): void {
  if (args.length > MAX_ARGS) throw new Error(`Workspace executor exceeds ${MAX_ARGS} arguments`)
  for (const value of args) {
    if (Buffer.byteLength(value) > MAX_ARG_BYTES) throw new Error('Workspace executor argument exceeds 16 KiB')
    if (value.includes('\u0000')) throw new Error('Workspace executor arguments may not contain NUL bytes')
  }
}

function safeArgs(values: string[] | undefined): string[] {
  if (!values) return []
  if (!Array.isArray(values)) throw new Error('args must be an array')
  return values.map((value) => boundedText(value, MAX_ARG_BYTES, 'argument'))
}

function safeFormat(value: string): string {
  const format = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9+_-]{0,31}$/.test(format)) throw new Error('Document format is invalid')
  return format
}

function boundedText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  if (value.includes('\u0000')) throw new Error(`${label} may not contain NUL bytes`)
  return value
}

function boundedNumber(value: number, min: number, max: number, label: string): string {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return String(value)
}

export function assertWorkspacePath(value: string): string {
  const raw = boundedText(value, 2048, 'workspace path').replaceAll('\\', '/')
  const normalized = posix.normalize(raw.startsWith('/') ? raw : `/${raw}`)
  if (normalized === '/..' || normalized.startsWith('/../')) throw new Error('Workspace path escapes root')
  return normalized
}

function assertWritableOutput(value: string): string {
  const path = assertWorkspacePath(value)
  if (!path.startsWith('/Workspace/') && !path.startsWith('/Library/Generated/')) {
    throw new Error('Generated process outputs must be under /Workspace or /Library/Generated')
  }
  return path
}

function assertWritableDirectory(value: string): string {
  const path = assertWorkspacePath(value)
  if (path !== '/Workspace' && !path.startsWith('/Workspace/') && path !== '/Library/Generated' && !path.startsWith('/Library/Generated/')) {
    throw new Error('Generated process output directories must be under /Workspace or /Library/Generated')
  }
  return path
}

function processPath(value: string): string {
  const path = assertWorkspacePath(value)
  return path === '/' ? '.' : `.${path}`
}
