import { indexText, stagedPaths } from './git.mjs'

const prefix = 'apps/server/src/agent/mastra/workspace-'
const changed = stagedPaths().filter((path) => path.startsWith(prefix) && /\.tsx?$/.test(path))
if (!changed.length) process.exit(0)

const errors = []
for (const path of changed) {
  const text = indexText(path) ?? ''
  if (/allowNetwork\s*:\s*true/.test(text)) errors.push(`${path}: workspace networking must fail closed`)
  if (/blockNetwork\s*\(\s*false\s*\)/.test(text)) errors.push(`${path}: nono network blocking may not be disabled`)
  if (/['"](?:process:shell|shell:exec|workspace:shell)['"]/.test(text)) errors.push(`${path}: generic shell authority may not be exposed as an agent capability`)
}

function requireTokens(path, requirements) {
  const text = indexText(path)
  if (!text) { errors.push(`${path}: required workspace security boundary is missing`); return }
  for (const [label, token] of requirements) if (!text.includes(token)) errors.push(`${path}: missing invariant: ${label}`)
}

requireTokens('apps/server/src/agent/mastra/workspace-nono-worker.ts', [
  ['workspace-only read/write capability', 'caps.allowPath(workspaceRoot, AccessMode.ReadWrite)'],
  ['network blocking', 'caps.blockNetwork()'],
  ['kernel capability application', 'apply(caps)'],
])
requireTokens('apps/server/src/agent/mastra/workspace-nono.ts', [
  ['bounded materialization', 'materializeForExecution()'],
  ['post-process reconciliation', 'reconcileExecution'],
  ['credential filtering', 'sensitiveEnvironmentKey'],
])
requireTokens('apps/server/src/agent/mastra/workspace-agentfs.ts', [
  ['execution file bound', 'MAX_EXECUTION_FILES'],
  ['execution byte bound', 'MAX_EXECUTION_BYTES'],
  ['upload library', '/Library/Uploads'],
  ['generated library', '/Library/Generated'],
  ['workspace root', '/Workspace'],
])
requireTokens('apps/server/src/agent/mastra/workspace-enclave.ts', [
  ['Python broker', "case 'process:python'"],
  ['Pandoc broker', "case 'process:pandoc'"],
  ['LibreOffice broker', "case 'process:libreoffice'"],
  ['ffmpeg broker', "case 'process:ffmpeg'"],
  ['Remotion broker', "case 'process:remotion'"],
  ['default-deny dispatch', 'AgentScript tool ${name} is not allowed'],
])

if (errors.length) {
  console.error('Workspace implementation boundary check failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  process.exit(1)
}
