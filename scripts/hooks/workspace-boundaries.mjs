import { indexText, stagedPaths } from './git.mjs'

const changed = stagedPaths().filter((path) => path.startsWith('apps/server/src/mastra/') && /\.tsx?$/.test(path))
if (!changed.length) process.exit(0)

const errors = []
const hostCapabilityAllowlist = new Set([
  'apps/server/src/mastra/workspace.ts',
  'apps/server/src/mastra/sandbox.ts',
  'apps/server/src/mastra/browser.ts',
  // Mastra persistence intentionally creates its own contained SQLite directory.
  'apps/server/src/mastra/storage.ts',
])
const forbiddenHostImports = [
  'node:fs', 'node:fs/promises', 'node:child_process', 'node:net', 'node:dgram', 'node:tls', 'node:http', 'node:https',
]

for (const path of changed) {
  const text = indexText(path)
  if (text === undefined) continue
  if (!hostCapabilityAllowlist.has(path)) {
    for (const specifier of forbiddenHostImports) {
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?:from\\s+|import\\s*\\()(['"])${escaped}\\1`).test(text)) {
        errors.push(`${path}: direct host capability import ${specifier} is only allowed in an explicit workspace/sandbox/browser/storage boundary`)
      }
    }
    if (/\bnew\s+Local(?:Filesystem|Sandbox)\b/.test(text)) errors.push(`${path}: LocalFilesystem/LocalSandbox construction belongs in workspace.ts`)
  }
  if (/allowNetwork\s*:\s*true/.test(text)) errors.push(`${path}: workspace command networking must fail closed`)
  if (/contained\s*:\s*false/.test(text)) errors.push(`${path}: workspace filesystems must remain contained`)
}

const workspace = indexText('apps/server/src/mastra/workspace.ts')
if (workspace !== undefined) {
  const required = [
    ['contained filesystem', /contained\s*:\s*true/],
    ['network disabled', /allowNetwork\s*:\s*false/],
    ['read-before-write', /requireReadBeforeWrite\s*:\s*true/],
    ['filesystem delete disabled', /FILESYSTEM\.DELETE\]\s*:\s*\{\s*enabled\s*:\s*false/],
    ['LSP host escape disabled', /LSP\.LSP_INSPECT\]\s*:\s*\{\s*enabled\s*:\s*false/],
  ]
  for (const [label, regex] of required) if (!regex.test(workspace)) errors.push(`apps/server/src/mastra/workspace.ts: missing invariant: ${label}`)
}

const sandbox = indexText('apps/server/src/mastra/sandbox.ts')
if (sandbox !== undefined) {
  const required = [
    ['Seatbelt deny-default', /\(deny default\)/],
    ['Seatbelt network denial', /\(deny network\*\)/],
    ['bubblewrap namespace isolation', /['"]--unshare-all['"]/],
  ]
  for (const [label, regex] of required) if (!regex.test(sandbox)) errors.push(`apps/server/src/mastra/sandbox.ts: missing invariant: ${label}`)
}

if (errors.length) {
  console.error('Workspace implementation boundary check failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  process.exit(1)
}
