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

// This worker moved from the nono-ts capability set to landstrip. The three
// invariants that mattered before are unchanged — write confined to the workspace,
// network blocked, kernel policy actually applied — but they are now expressed as a
// policy document plus runtime proof that the *resolved* policy is the intended one.
// Assert both halves. The declaration alone would not catch a landstrip schema change
// that silently widened the sandbox, which is the exact failure the preflight exists
// to convert into a refusal.
//
// Read confinement is weaker here than it was under nono-ts and that is deliberate:
// nono defaulted to no filesystem authority, whereas landstrip's Linux read model is a
// denylist. The data-directory entry is therefore load-bearing rather than incidental,
// and is asserted so it cannot be dropped without the boundary check objecting.
requireTokens('apps/server/src/agent/mastra/workspace-nono-worker.ts', [
  ['workspace-only write capability', 'allowWrite: [workspaceRoot]'],
  ['network blocking', 'allowNetwork: false'],
  ['kernel capability application', "'run', '-p', policyPath"],
  ['resolved write-root proof', 'resolved.writeRoots.includes(workspaceRoot)'],
  ['resolved network-restriction proof', "mode !== 'restricted'"],
  ['data-directory read denial', 'denyRead: [control.dataDir'],
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
