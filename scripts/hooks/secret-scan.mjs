import { addedLines, stagedPaths } from './git.mjs'

const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['generic bearer token', /\bBearer\s+[A-Za-z0-9._~+\/-]{32,}={0,2}\b/i],
]
const errors = []
for (const path of stagedPaths()) {
  if (/^(?:pnpm-lock\.yaml|compliance\/|.*fixtures?\/)/.test(path)) continue
  for (const item of addedLines(path)) {
    if (/example|placeholder|redacted|dummy/i.test(item.text)) continue
    for (const [label, pattern] of patterns) if (pattern.test(item.text)) errors.push(`${path}:${item.line}: possible ${label}`)
  }
}
if (errors.length) {
  console.error('Secret/key/material scan failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
