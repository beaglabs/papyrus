import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Prove the landstrip (Landlock + seccomp) boundary enforces: a write inside the
// workspace must succeed and a write outside it must fail. Fails closed when the
// host kernel lacks Landlock.
const landstrip = '/app/node_modules/.bin/landstrip'
const dir = mkdtempSync(join(tmpdir(), 'papyrus-probe-'))

try {
  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const policy = {
    filesystem: { allowWrite: [ws], allowRead: [ws, '/usr', '/bin', '/lib', '/lib64'] },
    network: { allowNetwork: false },
  }
  const policyPath = join(dir, 'policy.json')
  writeFileSync(policyPath, JSON.stringify(policy))

  const run = (cmd) => spawnSync(landstrip, ['run', '-p', policyPath, '--', '/bin/sh', '-c', cmd], { encoding: 'utf8' })

  const writeIn = run(`echo ok > '${ws}/probe'`)
  if (writeIn.status !== 0) {
    console.error('landstrip refused a permitted write; the boundary is unusable')
    process.exit(1)
  }

  const writeOut = run(`echo x > '${dir}/escape'`)
  if (writeOut.status === 0) {
    console.error('landstrip permitted a write outside the workspace; the boundary does not enforce')
    process.exit(1)
  }

  process.exit(0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
