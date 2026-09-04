import { accessSync, constants } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SandboxRuntime } from '../config.js'

/**
 * LocalSandbox policy.
 *
 * Mastra's LocalSandbox is NOT isolated by default: without native isolation
 * its commands run as the Papyrus process against the host filesystem. Papyrus
 * therefore never constructs one opportunistically.
 *
 * Linux defaults to Bubblewrap. macOS remains disabled by default because
 * sandbox-exec is deprecated, but an operator may explicitly select Seatbelt
 * with PAPYRUS_SANDBOX_RUNTIME=seatbelt for local development/testing.
 *
 * Network is always denied. A missing, incompatible, or invalid native backend
 * never falls back to unisolated command execution.
 */

export type SandboxIsolation = SandboxRuntime
export type SandboxIsolationSupport = SandboxIsolation | 'none'

/** Backwards-compatible names for Papyrus's default hardened deployment backend. */
export const SANDBOX_PLATFORM: NodeJS.Platform = 'linux'
export const SANDBOX_BINARY = 'bwrap'

const SANDBOX_PLATFORM_BY_RUNTIME: Record<SandboxIsolation, NodeJS.Platform> = {
  bwrap: 'linux',
  seatbelt: 'darwin',
}
const SANDBOX_BINARY_BY_RUNTIME: Record<SandboxIsolation, string> = {
  bwrap: 'bwrap',
  seatbelt: 'sandbox-exec',
}

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
  isolation?: SandboxIsolation
  canRun?: (binary: string) => boolean
}

export class SandboxUnavailableError extends Error {
  constructor(readonly policy: SandboxPolicy) {
    super(policy.reason)
    this.name = 'SandboxUnavailableError'
  }
}

function defaultCanRun(binary: string): boolean {
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, binary)),
    join('/usr/bin', binary),
    join('/bin', binary),
  ]
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

function defaultIsolation(platform: NodeJS.Platform): SandboxIsolation | undefined {
  return platform === 'linux' ? 'bwrap' : undefined
}

/**
 * Report whether this host can enforce the selected native isolation backend.
 * macOS Seatbelt is opt-in; leaving PAPYRUS_SANDBOX_RUNTIME unset preserves the
 * hardened Linux-default behavior.
 */
export function probeIsolation(options: SandboxProbeOptions = {}): SandboxIsolationSupport {
  const platform = options.platform ?? process.platform
  const isolation = options.isolation ?? defaultIsolation(platform)
  if (!isolation || SANDBOX_PLATFORM_BY_RUNTIME[isolation] !== platform) return 'none'
  const canRun = options.canRun ?? defaultCanRun
  return canRun(SANDBOX_BINARY_BY_RUNTIME[isolation]) ? isolation : 'none'
}

export interface ResolveSandboxPolicyInput extends SandboxProbeOptions {
  dataDir: string
  readOnlyPaths?: string[]
  /** Set false to keep code execution switched off even where native isolation exists. */
  allowExecution?: boolean
}

function unavailableReason(platform: NodeJS.Platform, requested: SandboxIsolation | undefined): string {
  if (requested) {
    const requiredPlatform = SANDBOX_PLATFORM_BY_RUNTIME[requested]
    if (platform !== requiredPlatform) {
      return requested === 'bwrap'
        ? 'PAPYRUS_SANDBOX_RUNTIME=bwrap requires Linux'
        : 'PAPYRUS_SANDBOX_RUNTIME=seatbelt requires macOS'
    }
    const binary = SANDBOX_BINARY_BY_RUNTIME[requested]
    return `${requested === 'bwrap' ? 'Bubblewrap' : 'Seatbelt'} (${binary}) was not found or is not executable; refusing to run code unisolated on the host`
  }
  if (platform === 'linux') {
    return 'Bubblewrap (bwrap) was not found or is not executable; refusing to run code unisolated on the host'
  }
  if (platform === 'darwin') {
    return 'Sandbox execution is disabled by default on macOS; set PAPYRUS_SANDBOX_RUNTIME=seatbelt to explicitly use Seatbelt (sandbox-exec)'
  }
  return `Sandboxed execution requires Linux with Bubblewrap by default; ${platform} is unsupported`
}

export function resolveSandboxPolicy(input: ResolveSandboxPolicyInput): SandboxPolicy {
  const platform = input.platform ?? process.platform
  const requested = input.isolation
  const isolation = probeIsolation(input)
  const workingDirectory = resolve(input.dataDir, 'sandbox')
  const readOnlyPaths = input.readOnlyPaths ?? []
  const base = { isolation, workingDirectory, allowNetwork: false as const, readOnlyPaths }

  if (input.allowExecution === false) {
    return { ...base, enabled: false, reason: 'Sandbox execution is disabled by configuration' }
  }
  if (isolation === 'none') {
    return { ...base, enabled: false, reason: unavailableReason(platform, requested) }
  }
  return {
    ...base,
    enabled: true,
    reason: isolation === 'bwrap'
      ? 'Code execution sandboxed with Bubblewrap isolation, network denied'
      : 'Code execution sandboxed with Seatbelt isolation, network denied',
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
