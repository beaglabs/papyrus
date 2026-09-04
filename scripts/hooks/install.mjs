import { execFileSync } from 'node:child_process'

if (process.env.CI) process.exit(0)

let root
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  // Package installs in release/container build contexts may not include .git.
  process.exit(0)
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' })
console.log('[papyrus] Git hooks installed from .githooks')
