import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { Enclave } from '@enclave-vm/core'
import { AccessMode, CapabilitySet, apply, isSupported, supportInfo } from 'nono-ts'

interface RunMessage { type: 'run'; code: string }
interface ToolResultMessage { type: 'tool_result'; id: string; success: boolean; value?: unknown; error?: string }
type ParentMessage = RunMessage | ToolResultMessage

const temp = process.env.PAPYRUS_ENCLAVE_TEMP
if (!temp) fail('PAPYRUS_ENCLAVE_TEMP is required')
const tempRoot = realpathSync(temp)

if (!isSupported()) {
  const info = supportInfo()
  fail(`nono-ts sandbox is unavailable on ${info.platform}: ${info.details}`)
}

const caps = new CapabilitySet()
caps.allowPath(tempRoot, AccessMode.ReadWrite)
caps.blockNetwork()

// Enclave is a programmable security layer, not the final host boundary.
// Keep the worker inside nono as defense in depth. Grant only read access to
// the Node runtime and installed package tree needed by already-trusted code.
for (const path of runtimeReadRoots()) {
  if (!existsSync(path)) continue
  try { caps.allowPath(path, AccessMode.Read) } catch { /* platform mismatch */ }
}
for (const path of ['/dev/null', '/dev/urandom', '/dev/random']) {
  if (!existsSync(path)) continue
  try { caps.allowFile(path, path === '/dev/null' ? AccessMode.ReadWrite : AccessMode.Read) } catch { /* optional */ }
}

try {
  apply(caps)
} catch (error) {
  fail(`Unable to apply nono-ts around Enclave: ${message(error)}`)
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let started = false
let sequence = 0

input.on('line', (line) => {
  let packet: ParentMessage
  try {
    packet = JSON.parse(line) as ParentMessage
  } catch {
    return fail('Invalid parent protocol message')
  }

  if (packet.type === 'tool_result') {
    const waiter = pending.get(packet.id)
    if (!waiter) return
    pending.delete(packet.id)
    if (packet.success) waiter.resolve(packet.value)
    else waiter.reject(new Error(packet.error ?? 'Brokered tool failed'))
    return
  }

  if (packet.type === 'run') {
    if (started) return fail('Enclave worker accepts one program')
    started = true
    void execute(packet.code)
  }
})

input.on('close', () => {
  for (const waiter of pending.values()) waiter.reject(new Error('Papyrus broker disconnected'))
  pending.clear()
})

async function execute(code: string): Promise<void> {
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
    toolHandler: async (name, args) => broker(name, args),
  })

  try {
    const result = await enclave.run(code)
    send({
      type: 'result',
      result: {
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
      },
    })
    process.exitCode = result.success ? 0 : 1
  } catch (error) {
    send({ type: 'worker_error', error: message(error) })
    process.exitCode = 70
  } finally {
    enclave.dispose()
    input.close()
  }
}

function broker(name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = `tool_${++sequence}`
  send({ type: 'tool_call', id, name, args })
  return new Promise((resolvePromise, reject) => pending.set(id, { resolve: resolvePromise, reject }))
}

function runtimeReadRoots(): string[] {
  const roots = new Set<string>([
    dirname(process.execPath),
    '/usr',
    '/bin',
    '/lib',
    '/lib64',
    '/opt',
    '/System',
    '/Library',
  ])
  for (const specifier of ['@enclave-vm/core', 'nono-ts']) {
    try {
      const resolved = fileURLToPath(import.meta.resolve(specifier))
      roots.add(packageTreeRoot(resolved))
    } catch { /* package was already loaded; fail closed if later reads are needed */ }
  }
  return [...roots]
}

function packageTreeRoot(resolved: string): string {
  const marker = `${sep}node_modules${sep}`
  const index = resolved.lastIndexOf(marker)
  return index >= 0 ? resolved.slice(0, index + marker.length - 1) : dirname(resolved)
}

function send(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function fail(value: string): never {
  process.stderr.write(`[papyrus-enclave] ${value}\n`)
  process.exit(70)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
