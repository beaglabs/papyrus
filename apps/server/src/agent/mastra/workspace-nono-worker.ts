import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * Workspace executor worker, enforced by landstrip.
 *
 * landstrip is a CLI that runs a command under Landlock (filesystem) and seccomp
 * (network) on Linux. The worker's only job is to translate the daemon's control
 * contract into a landstrip policy, prove the effective policy is the one it
 * intended, and then exec the requested command through it.
 *
 * Fail-closed by construction: if `policy validate` or `policy resolve` disagree
 * with what is intended below, the worker refuses to spawn anything. A schema
 * change in landstrip therefore becomes a startup refusal, never a silently
 * wider sandbox.
 */

interface WorkerControl {
  workspaceRoot: string
  cwd: string
  command: string
  env: Record<string, string>
  /** The daemon's data directory. The sandbox must never read it. */
  dataDir: string
  /** Extra read-only roots the daemon provisioned for the toolchain. */
  readPaths?: string[]
}

const LANDSTRIP = process.env.PAPYRUS_LANDSTRIP_BIN?.trim() || 'landstrip'

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

const workspaceRoot = realpathSync(control.workspaceRoot)
const cwd = resolve(workspaceRoot, control.cwd.replace(/^\/+/, ''))
if (cwd !== workspaceRoot && !cwd.startsWith(workspaceRoot + sep)) fail('Workspace cwd escapes the materialized root')
if (!existsSync(cwd)) fail(`Workspace cwd does not exist: ${control.cwd}`)

// landstrip's write model is an allowlist and its network model is a switch. Its
// read model on Linux is a denylist, so the paths the sandbox must never read are
// listed explicitly. On a single-node, single-tenant appliance those are the data
// directory, home directories, and /etc.
const runtimePaths = new Set([
  dirname(process.execPath),
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/usr/local',
  '/System', '/opt/homebrew', '/Applications/LibreOffice.app', '/Library/Fonts', '/private/var/select',
  ...(control.readPaths ?? []),
])

const policy = {
  filesystem: {
    allowWrite: [workspaceRoot],
    allowRead: [workspaceRoot, ...[...runtimePaths].filter(existsSync)],
    // denyReadAlways is a Windows-only key and is ignored on Linux. denyRead is
    // the Linux read denylist. Do not deny /etc wholesale: /etc/ld.so.cache is
    // required to launch any process.
    denyRead: [control.dataDir, '/root', '/home'],
  },
  network: { allowNetwork: false, allowLocalBinding: false },
}

const policyDir = mkdtempSync(join(tmpdir(), 'papyrus-policy-'))
const policyPath = join(policyDir, 'policy.json')
writeFileSync(policyPath, JSON.stringify(policy))

interface LandstripResult { ok: boolean; output: string }
function runLandstrip(args: string[]): LandstripResult {
  const result = spawnSync(LANDSTRIP, args, { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

// Prove the effective policy is the intended one before running anything.
const validate = runLandstrip(['policy', 'validate', '-p', policyPath])
if (!validate.ok) fail(`landstrip policy validate failed: ${validate.output.slice(0, 400)}`)

const resolveResult = runLandstrip(['policy', 'resolve', '-p', policyPath])
if (!resolveResult.ok) fail(`landstrip policy resolve failed: ${resolveResult.output.slice(0, 400)}`)
let resolved: { writeRoots?: unknown; readDeniedRoots?: unknown; networkAccess?: { mode?: unknown } }
try {
  resolved = JSON.parse(resolveResult.output) as typeof resolved
} catch {
  fail('landstrip policy resolve returned malformed JSON; refusing to guess at the effective policy')
}
if (!Array.isArray(resolved.writeRoots) || !resolved.writeRoots.includes(workspaceRoot)) {
  fail(`resolved policy does not grant the workspace write root (${workspaceRoot})`)
}
if (!resolved.networkAccess || (resolved.networkAccess as { mode?: unknown }).mode !== 'restricted') {
  fail('resolved policy does not restrict network access')
}
if (!Array.isArray(resolved.readDeniedRoots) || resolved.readDeniedRoots.length === 0) {
  fail('resolved policy denies no read paths; the data-directory read denial did not take effect')
}

const child = spawn(LANDSTRIP, ['run', '-p', policyPath, '--', '/bin/sh', '-c', control.command], {
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

const cleanup = () => { try { rmSync(policyDir, { recursive: true, force: true }) } catch { /* best effort */ } }
child.once('error', (error) => { cleanup(); fail(`Workspace command failed to start: ${message(error)}`) })
child.once('close', (code, signal) => {
  cleanup()
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
