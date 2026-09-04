import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

if (process.env.CI || process.env.PAPYRUS_SKIP_HOOK_INSTALL === '1') process.exit(0)
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })
  console.log('[papyrus] configured core.hooksPath=.githooks')
} catch {
  // prepare may run outside a Git worktree when packaging.
}
