import { spawnSync } from 'node:child_process'
import { stagedPaths } from './git.mjs'

const staged = stagedPaths()
if (!staged.length) process.exit(0)

function run(label, command, args) {
  process.stdout.write(`\n[papyrus] ${label}\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false })
  if (result.error) { console.error(`[papyrus] ${label} could not start: ${result.error.message}`); process.exit(1) }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const changed = (prefix) => staged.some((path) => path === prefix || path.startsWith(prefix))
const securityChanged = staged.some((path) =>
  path === 'apps/server/src/agent/config.ts' ||
  path.startsWith('apps/server/src/agent/action-') ||
  path.startsWith('apps/server/src/agent/mastra/') ||
  path.startsWith('packages/contracts/'))
const workspaceChanged = changed('apps/server/src/agent/mastra/workspace-')
const webChanged = changed('apps/web/src/') || changed('apps/web/scripts/')

run('filename / case / path sanity', 'node', ['scripts/hooks/filename-sanity.mjs'])
run('secret / key / material scan', 'node', ['scripts/hooks/secret-scan.mjs'])
run('junk / debugging scan', 'node', ['scripts/hooks/junk-scan.mjs'])
run('contract / schema drift', 'node', ['scripts/hooks/contracts-drift.mjs'])
if (workspaceChanged) run('workspace implementation boundaries', 'node', ['scripts/hooks/workspace-boundaries.mjs'])

if (securityChanged) run('security invariants', 'pnpm', [
  '--filter', '@papyrus/server', 'exec', 'vitest', 'run', 'tests/security-invariants.test.ts', 'tests/agent-mastra.test.ts',
])

if (webChanged) {
  run('frontend accessibility guard', 'pnpm', ['--filter', '@papyrus/web', 'exec', 'node', 'scripts/precommit-a11y.mjs'])
  run('frontend React / TypeScript typecheck', 'pnpm', ['--filter', '@papyrus/web', 'typecheck'])
  run('Markdown output fixtures', 'pnpm', ['--filter', '@papyrus/web', 'exec', 'vitest', 'run', 'src/Markdown.test.tsx', 'src/markdown-fixtures.test.tsx'])
}

run('SBOM / SSP generation and compliance drift', 'pnpm', ['compliance:check'])
console.log('\n[papyrus] pre-commit guardrails passed')
