import { spawnSync } from 'node:child_process'
import { stagedPaths } from './git.mjs'

const staged = stagedPaths()
if (!staged.length) process.exit(0)

function run(label, command, args) {
  process.stdout.write(`\n[papyrus] ${label}\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false })
  if (result.error) {
    console.error(`[papyrus] ${label} could not start: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const changed = (prefix) => staged.some((path) => path === prefix || path.startsWith(prefix))
const serverSecurityChanged = staged.some((path) =>
  path === 'apps/server/src/config.ts' ||
  path === 'apps/server/src/policy.ts' ||
  path === 'apps/server/src/audit.ts' ||
  path === 'apps/server/src/catalog.ts' ||
  path.startsWith('apps/server/src/mastra/') ||
  path.startsWith('contracts/') ||
  path.startsWith('acp-runtime/'))
const webChanged = changed('apps/web/src/') || changed('apps/web/scripts/')
const workspaceChanged = changed('apps/server/src/mastra/')

run('filename / case / path sanity', 'node', ['scripts/hooks/filename-sanity.mjs'])
run('secret / key / material scan', 'node', ['scripts/hooks/secret-scan.mjs'])
run('junk / debugging scan', 'node', ['scripts/hooks/junk-scan.mjs'])
run('contract / schema drift', 'node', ['scripts/hooks/contracts-drift.mjs'])
run('contract conformance harness', 'pnpm', ['contracts:test'])

if (workspaceChanged) run('workspace implementation boundaries', 'node', ['scripts/hooks/workspace-boundaries.mjs'])

if (serverSecurityChanged) {
  run('security invariants', 'pnpm', [
    '--filter', '@papyrus/server', 'exec', 'vitest', 'run',
    'src/config.test.ts', 'tests/policy.test.ts', 'tests/security-invariants.test.ts',
  ])
  if (workspaceChanged) {
    run('workspace regression tests', 'pnpm', [
      '--filter', '@papyrus/server', 'exec', 'vitest', 'run',
      'tests/mastra-workspace.test.ts', 'tests/mastra-tools.test.ts',
    ])
  }
}

if (webChanged) {
  run('frontend accessibility / React AST lint', 'pnpm', [
    '--filter', '@papyrus/web', 'exec', 'node', 'scripts/precommit-a11y.mjs',
  ])
  run('frontend React / TypeScript typecheck', 'pnpm', ['--filter', '@papyrus/web', 'typecheck'])
  run('Markdown / agent-output fixtures', 'pnpm', [
    '--filter', '@papyrus/web', 'exec', 'vitest', 'run',
    'src/AcpSessionContent.test.tsx', 'src/markdown-fixtures.test.tsx',
  ])
}

run('SBOM / SSP generation and compliance drift', 'pnpm', ['compliance:check'])

console.log('\n[papyrus] pre-commit guardrails passed')
