import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { AccessMode, CapabilitySet, apply, isSupported, supportInfo } from 'nono-ts'

interface WorkerControl {
  workspaceRoot: string
  cwd: string
  command: string
  env: Record<string, string>
}

const controlPath = process.argv[2]
if (!controlPath) fail('Missing workspace executor control file')

let control: WorkerControl
try {
  control = JSON.parse(readFileSync(controlPath, 'utf8')) as WorkerControl
} catch (error) {
  fail(`Unable to read workspace executor control: ${message(error)}`)
} finally {
  try { rmSync(controlPath, { force: true }) } catch { /* best effort */ }
}

if (!isSupported()) {
  const info = supportInfo()
  fail(`nono-ts sandbox is unavailable on ${info.platform}: ${info.details}`)
}

const workspaceRoot = realpathSync(control.workspaceRoot)
const cwd = resolve(workspaceRoot, control.cwd.replace(/^\/+/, ''))
if (cwd !== workspaceRoot && !cwd.startsWith(workspaceRoot + sep)) fail('Workspace cwd escapes the materialized root')
if (!existsSync(cwd)) fail(`Workspace cwd does not exist: ${control.cwd}`)

const caps = new CapabilitySet()
caps.allowPath(workspaceRoot, AccessMode.ReadWrite)
caps.blockNetwork()

// nono intentionally defaults to no filesystem authority. Grant only the
// read-only runtime locations required to execute the local shell/toolchain.
// User home directories and the Papyrus data directory are not included.
const runtimePaths = new Set([
  dirname(process.execPath),
  '/usr',
  '/bin',
  '/lib',
  '/lib64',
  '/opt',
  '/System',
  '/Library',
])
for (const path of runtimePaths) {
  if (!existsSync(path)) continue
  try { caps.allowPath(path, AccessMode.Read) } catch { /* platform path mismatch */ }
}
for (const path of ['/dev/null', '/dev/urandom', '/dev/random']) {
  if (!existsSync(path)) continue
  try { caps.allowFile(path, path === '/dev/null' ? AccessMode.ReadWrite : AccessMode.Read) } catch { /* optional */ }
}


try {
  apply(caps)
} catch (error) {
  fail(`Unable to apply nono-ts sandbox: ${message(error)}`)
}

const child = spawn('/bin/sh', ['-c', control.command], {
  cwd,
  env: control.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: false,
  windowsHide: true,
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

const forward = (signal: NodeJS.Signals) => {
  try { child.kill(signal) } catch { /* already exited */ }
}
process.on('SIGTERM', () => forward('SIGTERM'))
process.on('SIGINT', () => forward('SIGINT'))

child.once('error', (error) => fail(`Workspace command failed to start: ${message(error)}`))
child.once('close', (code, signal) => {
  if (signal) process.exit(128)
  process.exit(code ?? 1)
})

function fail(value: string): never {
  process.stderr.write(`[papyrus-workspace] ${value}\n`)
  process.exit(70)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
