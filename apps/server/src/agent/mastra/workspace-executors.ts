import { accessSync, constants } from 'node:fs'
import { delimiter, join, posix } from 'node:path'
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

/**
 * Where a Papyrus-provisioned Python environment lives, when one exists.
 *
 * The interpreter that ships with the host has no document libraries at all — no PDF reader, no
 * PDF writer, no image decoder — so an agent asked to work on a PDF writes one from scratch and
 * spends its whole step budget debugging its own parser. An appliance that provisions
 * `<data-dir>/python` (see `scripts/provision-python.sh`) gets an interpreter that can read and
 * write these formats; with no such environment this returns `python3` and nothing changes.
 */
export function resolvePythonInterpreter(options: { dataDir: string; env?: NodeJS.ProcessEnv }): string {
  const env = options.env ?? process.env
  const override = env['PAPYRUS_PYTHON_BIN']?.trim()
  if (override) return override
  const provisioned = join(options.dataDir, 'python', 'bin', 'python3')
  try {
    accessSync(provisioned, constants.X_OK)
    return provisioned
  } catch {
    return 'python3'
  }
}

/**
 * Resolve a tool against PATH, trying each candidate name in order.
 *
 * LibreOffice installs as `libreoffice` on Linux and as `soffice` from the macOS package, so a
 * hardcoded name makes every conversion fail with exit 127 on one of the two platforms — which
 * is what happened, and the agent then spent steps discovering that the tool was "missing".
 * An absolute candidate is honoured only if it is executable.
 */
export function resolveCommand(candidates: string[], env: NodeJS.ProcessEnv = process.env): string {
  const directories = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean)
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.includes('/')) {
      try { accessSync(candidate, constants.X_OK); return candidate } catch { /* not installed here */ }
      continue
    }
    for (const directory of directories) {
      try { accessSync(join(directory, candidate), constants.X_OK); return candidate } catch { /* next */ }
    }
  }
  return candidates.find(Boolean) ?? ''
}

/**
 * Root of the toolchain that ships inside the appliance image.
 *
 * The image build stages pandoc, LibreOffice, and ffmpeg here and the sandbox
 * grants this root read-only access. Resolution prefers it over PATH so an
 * appliance runs the pinned binary it shipped rather than whatever the host
 * happens to have — which is the difference between a reproducible conversion and
 * a support ticket about fonts.
 */
export function resolveToolchainRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env['PAPYRUS_TOOLCHAIN_DIR']?.trim() || '/opt/papyrus/toolchain'
}

export class WorkspaceExecutorRegistry {
  private readonly python: string
  private readonly pandoc: string
  private readonly libreOffice: string
  private readonly ffmpeg: string
  private readonly pnpm: string

  constructor(
    private readonly sandbox: NonoWorkspaceSandbox,
    options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    const env = options.env ?? process.env
    const toolchain = resolveToolchainRoot(env)
    this.python = options.dataDir ? resolvePythonInterpreter({ dataDir: options.dataDir, env }) : 'python3'
    // Bundled path first, then any explicit override, then PATH. `resolveCommand`
    // honours an absolute candidate only when it is executable, so an absent
    // bundle degrades to the host toolchain instead of pointing at nothing.
    this.pandoc = resolveCommand(
      [join(toolchain, 'bin', 'pandoc'), env['PAPYRUS_PANDOC_BIN'] ?? '', 'pandoc'],
      env,
    )
    this.libreOffice = resolveCommand(
      [
        join(toolchain, 'bin', 'libreoffice'),
        join(toolchain, 'bin', 'soffice'),
        env['PAPYRUS_LIBREOFFICE_BIN'] ?? '',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        'libreoffice',
        'soffice',
      ],
      env,
    )
    this.ffmpeg = resolveCommand([join(toolchain, 'bin', 'ffmpeg'), env['PAPYRUS_FFMPEG_BIN'] ?? '', 'ffmpeg'], env)
    this.pnpm = resolveCommand([join(toolchain, 'bin', 'pnpm'), env['PAPYRUS_PNPM_BIN'] ?? '', 'pnpm'], env)
  }

  async runPython(input: { scriptPath: string; args?: string[]; cwd?: string }): Promise<WorkspaceProcessResult> {
    const script = processPath(input.scriptPath)
    if (!script.toLowerCase().endsWith('.py')) throw new Error('runPython requires a .py script inside the workspace')
    return this.execute('python', this.python, [script, ...safeArgs(input.args)], input.cwd ?? '/', 120_000)
  }

  async runPandoc(input: { inputPath: string; outputPath: string; from?: string; to?: string }): Promise<WorkspaceProcessResult> {
    const source = processPath(input.inputPath)
    const target = processPath(assertWritableOutput(input.outputPath))
    const args = [source, '-o', target]
    if (input.from) args.push('--from', safeFormat(input.from))
    if (input.to) args.push('--to', safeFormat(input.to))
    return this.execute('pandoc', this.pandoc, args, '/', 120_000)
  }

  async runLibreOffice(input: { inputPath: string; outputDir?: string; outputFormat: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'html' | 'txt' }): Promise<WorkspaceProcessResult> {
    const source = processPath(input.inputPath)
    const outputDir = processPath(assertWritableDirectory(input.outputDir ?? '/Library/Generated'))
    return this.execute('libreoffice', this.libreOffice, [
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
    if (input.videoCodec) args.push('-c:v', input.videoCodec === 'vp9' ? 'libvpx-vp9' : input.videoCodec)
    if (input.audioCodec) args.push('-c:a', input.audioCodec)
    args.push(processPath(assertWritableOutput(input.outputPath)))
    return this.execute('ffmpeg', this.ffmpeg, args, '/', 300_000)
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
    return this.execute('remotion', this.pnpm, args, '/', 600_000)
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
