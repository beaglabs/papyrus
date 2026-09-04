import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contractsRoot = dirname(here)
const repoRoot = dirname(contractsRoot)

test('contracts and ACP runtime live at repository root with no legacy packages level', () => {
  const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /-\s+["']contracts["']/)
  assert.match(workspace, /-\s+["']acp-runtime["']/)
  assert.doesNotMatch(workspace, /packages\/\*/)
  assert.equal(existsSync(join(repoRoot, 'packages')), false)
})
test('contracts package exposes the public plugin contract barrel', () => {
  const manifest = JSON.parse(readFileSync(join(contractsRoot, 'package.json'), 'utf8'))
  assert.ok(manifest.exports?.['.'])
  assert.ok(manifest.exports?.['./plugins'])
})
