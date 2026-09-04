import { addedLines, stagedPaths } from './git.mjs'

const source = /\.(?:[cm]?[jt]sx?)$/i
const paths = stagedPaths().filter((path) => source.test(path))
const errors = []
const patterns = [
  { label: 'debugger statement', regex: /\bdebugger\s*;?/ },
  { label: 'console.log debugging', regex: /\bconsole\.log\s*\(/ },
  { label: 'console.debug debugging', regex: /\bconsole\.debug\s*\(/ },
  { label: 'security TODO marker', regex: /\b(?:TODO_SECURITY|FIXME_SECURITY)\b/ },
  { label: 'authentication bypass marker', regex: /\b(?:AUTH_BYPASS|SKIP_AUTH|DISABLE_AUTH)\b/ },
]

for (const path of paths) {
  for (const { line, text } of addedLines(path)) {
    if (/^\s*\/\//.test(text) && /console\.(?:log|debug)/.test(text)) continue
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) errors.push(`${path}:${line}: ${pattern.label}`)
    }
  }
}

if (errors.length) {
  console.error('Junk/debugging code check failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  process.exit(1)
}
