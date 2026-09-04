import { execFileSync } from 'node:child_process'

export function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (options.allowFailure) return undefined
    const stderr = error?.stderr?.toString?.().trim()
    throw new Error(stderr ? `git ${args.join(' ')}: ${stderr}` : `git ${args.join(' ')} failed`)
  }
}

export function repoRoot() {
  return git(['rev-parse', '--show-toplevel']).trim()
}

export function stagedPaths() {
  const root = repoRoot()
  const raw = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root })
  return raw.split('\0').filter(Boolean)
}

export function trackedPaths() {
  const root = repoRoot()
  const raw = git(['ls-files', '-z'], { cwd: root })
  return raw.split('\0').filter(Boolean)
}

export function indexText(path) {
  const root = repoRoot()
  const staged = git(['show', `:${path}`], { cwd: root, allowFailure: true })
  if (staged !== undefined) return staged
  return undefined
}

export function indexBlob(path) {
  const root = repoRoot()
  const value = git(['rev-parse', `:${path}`], { cwd: root, allowFailure: true })
  return value?.trim()
}

export function addedLines(path) {
  const root = repoRoot()
  const diff = git(['diff', '--cached', '--unified=0', '--no-color', '--', path], { cwd: root })
  const result = []
  let newLine = 0
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue
    if (line.startsWith('+')) {
      result.push({ line: newLine, text: line.slice(1) })
      newLine += 1
      continue
    }
    if (line.startsWith('-')) continue
    if (line.startsWith('\\ No newline')) continue
    if (newLine > 0) newLine += 1
  }
  return result
}
