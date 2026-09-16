import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCommand, resolveToolchainRoot } from '../src/agent/mastra/workspace-executors.js'

/**
 * Toolchain resolution.
 *
 * The appliance ships pandoc, LibreOffice, and ffmpeg inside the image, and the
 * sandbox is only permitted to read the roots it is granted. These tests pin the
 * two halves that fail quietly: which root is granted, and which binary wins.
 */

const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()?.() })

function toolchainBundle(programs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'papyrus-toolchain-'))
  disposers.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'bin'), { recursive: true })
  for (const program of programs) {
    const path = join(root, 'bin', program)
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  return root
}

describe('toolchain root', () => {
  it('defaults to the appliance location and honours the override', () => {
    expect(resolveToolchainRoot({})).toBe('/opt/papyrus/toolchain')
    expect(resolveToolchainRoot({ PAPYRUS_TOOLCHAIN_DIR: '/srv/toolchain' })).toBe('/srv/toolchain')
    // Whitespace-only is not a configured root.
    expect(resolveToolchainRoot({ PAPYRUS_TOOLCHAIN_DIR: '   ' })).toBe('/opt/papyrus/toolchain')
  })
})

describe('binary resolution', () => {
  it('prefers the bundled binary over one on PATH', () => {
    const root = toolchainBundle(['pandoc'])
    const bundled = join(root, 'bin', 'pandoc')
    // `/bin/echo` stands in for a host pandoc that must not win.
    const resolved = resolveCommand([bundled, '/bin/echo', 'pandoc'], { PATH: '/bin:/usr/bin' })
    expect(resolved).toBe(bundled)
  })

  it('falls back to PATH when the bundle does not carry the program', () => {
    const root = toolchainBundle(['pandoc'])
    const resolved = resolveCommand([join(root, 'bin', 'ffmpeg'), '', 'sh'], { PATH: '/bin:/usr/bin' })
    expect(resolved).toBe('sh')
  })

  it('skips an absolute candidate that exists but is not executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'papyrus-toolchain-'))
    disposers.push(() => rmSync(root, { recursive: true, force: true }))
    const notExecutable = join(root, 'pandoc')
    writeFileSync(notExecutable, 'not a program\n', { mode: 0o644 })
    // A readable-but-unrunnable file must not be chosen: that is the failure that
    // makes the agent report a missing tool it can see.
    expect(resolveCommand([notExecutable, 'sh'], { PATH: '/bin:/usr/bin' })).toBe('sh')
  })

  it('returns the bare candidate when nothing resolves, so the spawn fails loudly', () => {
    expect(resolveCommand(['definitely-not-installed-anywhere'], { PATH: '/bin:/usr/bin' })).toBe('definitely-not-installed-anywhere')
  })

  it('treats an empty PATH as the default rather than searching nothing', () => {
    expect(resolveCommand(['sh'], { PATH: '' })).toBe('sh')
  })
})
