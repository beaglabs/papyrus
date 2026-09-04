import { addedLines, stagedPaths } from './git.mjs'

const patterns = [
  ['debugger statement', /\bdebugger\s*;/],
  ['focused test', /\b(?:it|test|describe)\.only\s*\(/],
  ['console.debug', /\bconsole\.debug\s*\(/],
  ['TypeScript suppression', /@ts-ignore\b/],
  ['temporary throw', /throw new Error\(['"`](?:TODO|FIXME|temporary)/i],
]
const errors = []
for (const path of stagedPaths().filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
  for (const item of addedLines(path)) {
    for (const [label, pattern] of patterns) if (pattern.test(item.text)) errors.push(`${path}:${item.line}: ${label}`)
  }
}
if (errors.length) {
  console.error('Junk/debugging scan failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
