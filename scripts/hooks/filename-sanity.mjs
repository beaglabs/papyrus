import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot, stagedPaths, trackedPaths } from './git.mjs'

const root = repoRoot()
const staged = new Set(stagedPaths())
const tracked = trackedPaths()
const errors = []
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const invisible = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/

for (const path of tracked) {
  const normalized = path.normalize('NFC')
  if (normalized !== path) errors.push(`${path}: path must be Unicode NFC-normalized`)
  if (invisible.test(path)) errors.push(`${path}: path contains invisible or bidirectional control characters`)
  if (path.includes('\\')) errors.push(`${path}: backslashes are not valid repository path separators`)
  if (path.length > 240) errors.push(`${path}: path exceeds the 240-character cross-platform limit`)
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..') errors.push(`${path}: invalid path component ${JSON.stringify(part)}`)
    if (part.length > 120) errors.push(`${path}: path component ${JSON.stringify(part)} exceeds 120 characters`)
    if (/^[\s]|[\s.]$/.test(part)) errors.push(`${path}: path components may not start with whitespace or end with whitespace/dot`)
    if (/[\x00-\x1F\x7F]/.test(part)) errors.push(`${path}: path contains control characters`)
    if (reserved.test(part)) errors.push(`${path}: ${JSON.stringify(part)} is a reserved Windows filename`)
  }
}

const seen = new Map()
for (const path of tracked) {
  const key = path.normalize('NFC').toLocaleLowerCase('en-US')
  const previous = seen.get(key)
  if (previous && previous !== path) errors.push(`${path}: case/normalization collision with ${previous}`)
  else seen.set(key, path)
}

for (const path of staged) {
  const lower = path.toLowerCase()
  if (lower === '.ds_store' || lower.endsWith('/.ds_store')) errors.push(`${path}: OS metadata must not be committed`)
  if (lower.includes('/node_modules/') || lower.startsWith('node_modules/')) errors.push(`${path}: dependency directories must not be committed`)
  try {
    const stats = statSync(resolve(root, path))
    if (stats.isFile() && stats.size > 10 * 1024 * 1024) errors.push(`${path}: staged file exceeds 10 MiB; use an artifact/model store instead`)
  } catch {
    // Renames/deletions can race with the working tree; Git remains authoritative.
  }
}

if (errors.length) {
  console.error('Filename/case/path sanity check failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  process.exit(1)
}
