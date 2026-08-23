import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { FileConflictError, ManagedFileRoot, sha256 } from './managed-files.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'papyrus-files-'))
  roots.push(root)
  writeFileSync(resolve(root, 'policy.txt'), 'approved')
  return { root, files: new ManagedFileRoot(root) }
}

describe('ManagedFileRoot', () => {
  it('lists and reads files with content hashes', () => {
    const { files } = fixture()
    const entry = files.list('mount-1')[0]!
    expect(entry.path).toBe('/policy.txt')
    expect(entry.sha256).toBe(sha256(Buffer.from('approved')))
    expect(files.read('/policy.txt').content.toString()).toBe('approved')
  })

  it('publishes atomically only when the base hash still matches', () => {
    const { root, files } = fixture()
    const base = files.read('/policy.txt').sha256
    files.publish('/policy.txt', base, Buffer.from('revised'))
    expect(readFileSync(resolve(root, 'policy.txt'), 'utf8')).toBe('revised')
    expect(() => files.publish('/policy.txt', base, Buffer.from('stale'))).toThrow(FileConflictError)
  })

  it('does not follow symlinks outside the assigned mount', () => {
    const { root, files } = fixture()
    const outside = mkdtempSync(resolve(tmpdir(), 'papyrus-outside-'))
    roots.push(outside)
    writeFileSync(resolve(outside, 'secret.txt'), 'secret')
    symlinkSync(resolve(outside, 'secret.txt'), resolve(root, 'escape.txt'))
    expect(files.list('mount-1').some((entry) => entry.name === 'escape.txt')).toBe(false)
    expect(() => files.read('/escape.txt')).toThrow(/escapes/)
  })
})
