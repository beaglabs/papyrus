import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/**
 * LocalSandbox policy.
 *
 * Mastra's LocalSandbox is NOT isolated by default: without native isolation
 * its commands run as the Papyrus process against the host filesystem. Papyrus
 * therefore never constructs one opportunistically.
 *
 * Sandboxed execution is Linux-only, enforced through Bubblewrap. macOS is
 * deliberately unsupported: its native mechanism is Seatbelt (`sandbox-exec`),
 * which Apple has deprecated, so offering it would imply a guarantee we cannot
 * stand behind. Papyrus itself still runs on macOS for local development — it
 * simply runs with the sandbox disabled and says so.
 *
 * Network is always denied. With native isolation enabled Mastra blocks network
 * by default; we state it explicitly so the guarantee does not depend on a
 * library default that could change.
 */

/** Bubblewrap is the only isolation backend Papyrus will use. */
export type SandboxIsolation = 'bwrap'
export type SandboxIsolationSupport = SandboxIsolation | 'none'

export const SANDBOX_PLATFORM: NodeJS.Platform = 'linux'
export const SANDBOX_BINARY = 'bwrap'

/** Shape accepted by Mastra's LocalSandbox constructor. */
export interface LocalSandboxOptions {
  workingDirectory: string
  isolation: SandboxIsolation
  nativeSandbox: {
    allowNetwork: false
    readOnlyPaths: string[]
  }
}

export interface SandboxPolicy {
  enabled: boolean
  isolation: SandboxIsolationSupport
  workingDirectory: string
  allowNetwork: false
  readOnlyPaths: string[]
  reason: string
}

export interface SandboxProbeOptions {
  platform?: NodeJS.Platform
  canRun?: (binary: string) => boolean
}

export class SandboxUnavailableError extends Error {
  constructor(readonly policy: SandboxPolicy) {
    super(policy.reason)
    this.name = 'SandboxUnavailableError'
  }
}

function defaultCanRun(binary: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, binary))) return true
  }
  return existsSync(join('/usr/bin', binary)) || existsSync(join('/bin', binary))
}

/** Report whether this host can enforce Bubblewrap isolation. */
export function probeIsolation(options: SandboxProbeOptions = {}): SandboxIsolationSupport {
  const platform = options.platform ?? process.platform
  if (platform !== SANDBOX_PLATFORM) return 'none'
  const canRun = options.canRun ?? defaultCanRun
  return canRun(SANDBOX_BINARY) ? 'bwrap' : 'none'
}

export interface ResolveSandboxPolicyInput extends SandboxProbeOptions {
  dataDir: string
  readOnlyPaths?: string[]
  /** Set false to keep code execution switched off even where Bubblewrap exists. */
  allowExecution?: boolean
}

function unsupportedPlatformReason(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'Sandboxed execution requires Linux with Bubblewrap; macOS is unsupported because Seatbelt (sandbox-exec) is deprecated by Apple'
  }
  return `Sandboxed execution requires Linux with Bubblewrap; ${platform} is unsupported`
}

export function resolveSandboxPolicy(input: ResolveSandboxPolicyInput): SandboxPolicy {
  const platform = input.platform ?? process.platform
  const isolation = probeIsolation(input)
  const workingDirectory = resolve(input.dataDir, 'sandbox')
  const readOnlyPaths = input.readOnlyPaths ?? []
  const base = { isolation, workingDirectory, allowNetwork: false as const, readOnlyPaths }

  if (input.allowExecution === false) {
    return { ...base, enabled: false, reason: 'Sandbox execution is disabled by configuration' }
  }
  if (platform !== SANDBOX_PLATFORM) {
    return { ...base, enabled: false, reason: unsupportedPlatformReason(platform) }
  }
  if (isolation === 'none') {
    return {
      ...base,
      enabled: false,
      reason: `Bubblewrap (${SANDBOX_BINARY}) was not found on PATH; refusing to run code unisolated on the host`,
    }
  }
  return {
    ...base,
    enabled: true,
    reason: 'Code execution sandboxed with Bubblewrap isolation, network denied',
  }
}

/** Throw rather than allow an unisolated fallback. */
export function assertUsableSandbox(policy: SandboxPolicy): void {
  if (!policy.enabled) throw new SandboxUnavailableError(policy)
}

/** Mastra-shaped constructor options, or undefined when the sandbox is disabled. */
export function localSandboxOptions(policy: SandboxPolicy): LocalSandboxOptions | undefined {
  if (!policy.enabled || policy.isolation === 'none') return undefined
  return {
    workingDirectory: policy.workingDirectory,
    isolation: policy.isolation,
    nativeSandbox: {
      allowNetwork: false,
      readOnlyPaths: policy.readOnlyPaths,
    },
  }
}
