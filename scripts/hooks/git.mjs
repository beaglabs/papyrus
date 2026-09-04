import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))

export function git(args, allowFailure = false) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFailure) return undefined
    const stderr = error?.stderr?.toString?.().trim()
    throw new Error(stderr ? `git ${args.join(' ')}: ${stderr}` : `git ${args.join(' ')} failed`)
  }
}
export function stagedPaths() { return (git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']) ?? '').split('\0').filter(Boolean) }
export function trackedPaths() { return (git(['ls-files', '-z']) ?? '').split('\0').filter(Boolean) }
export function indexText(path) { return git(['show', `:${path}`], true) }
export function indexBlob(path) { return git(['rev-parse', `:${path}`], true)?.trim() }
export function addedLines(path) {
  const diff = git(['diff', '--cached', '--unified=0', '--', path], true) ?? ''
  const lines = []
  let next = 0
  for (const line of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) { next = Number(header[1]); continue }
    if (line.startsWith('+') && !line.startsWith('+++')) { lines.push({ line: next, text: line.slice(1) }); next += 1; continue }
    if (!line.startsWith('-')) next += 1
  }
  return lines
}
