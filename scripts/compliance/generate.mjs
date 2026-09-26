import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const check = process.argv.includes('--check')
const contractSources = [
  'packages/contracts/src/index.ts',
  'apps/server/src/agent/mastra/tools.ts',
  'apps/server/src/agent/mastra/workspace-agentfs.ts',
  'apps/server/src/agent/apps/project.ts',
  'apps/server/src/agent/policies/evaluator.ts',
]
const evidencePaths = [
  'apps/server/src/agent/config.ts',
  'apps/server/src/agent/http.ts',
  'apps/server/src/agent/action-worker.ts',
  'apps/server/src/agent/apps/http.ts',
  'apps/server/src/agent/apps/store.ts',
  'apps/server/src/agent/apps/migration.ts',
  'apps/server/src/agent/policies/store.ts',
  'apps/server/src/agent/policies/runtime.ts',
  'apps/server/src/agent/session-connector-access.ts',
  'apps/server/src/agent/catalog.ts',
  'apps/server/src/agent/link-store.ts',
  'apps/server/src/agent/link-action-attachments.ts',
  'apps/server/src/agent/link-http.ts',
  'apps/server/src/agent/link-preview.ts',
  'apps/server/src/agent/executors/link-publisher-executor.ts',
  'apps/server/src/agent/mastra/runtime.ts',
  'apps/server/src/agent/mastra/workspace-agentfs.ts',
  'apps/server/src/agent/mastra/workspace-nono.ts',
  'apps/server/src/agent/mastra/workspace-nono-worker.ts',
  'apps/server/src/agent/mastra/workspace-enclave.ts',
]
function git(args, allowFailure = false) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { if (allowFailure) return undefined; throw error }
}
function blob(path) {
  const value = git(['rev-parse', `:${path}`], true)?.trim()
  if (!value) throw new Error(`Required staged file is missing: ${path}`)
  return value
}
function staged(path) { return git(['show', `:${path}`], true) }

const contractText = JSON.stringify({ formatVersion: 1, sources: contractSources.map((path) => ({ path, gitBlob: blob(path) })) }, null, 2) + '\n'
const evidenceRows = evidencePaths.map((path) => `| \`${path}\` | \`${blob(path)}\` |`).join('\n')
const sspText = `# Papyrus System Security Plan (Repository-Derived)

> Generated control-evidence artifact. This is repository evidence, not an authorization decision or certification.

## System boundary

Papyrus is a customer-hosted durable agent runtime. The repository boundary includes the portal, daemon, Mastra runtime, AgentFS workspace, nono isolation workers, Enclave broker, action ledger, approved action executors, and the approval-backed Links and hosted App publication and serving boundaries.

## Security invariants

- External side effects cross the proposal → human approval → ledger → leased executor boundary.
- AgentFS is the durable file authority; native processes work through bounded materialize → isolate → reconcile behavior.
- Link publication snapshots exact AgentFS bytes before approval and verifies the SHA-256 again before making the Link live.
- Hosted App publication approves an immutable, digest-checked build candidate; source edits and preview builds never advance the production pointer.
- Hosted App content is served from a separate HTTPS origin in a script-only sandbox. Entra authentication and brokered connector access remain on the portal origin.
- App runtime connector grants are durable and operation-specific, separate from the authoring session's bindings; low-level dispatch rechecks grants and active connector state.
- Named, attached policy rules are evaluated deterministically. The policy specialist cannot activate an authority-weakening change without Governance approval.
- Link drafts, published blobs, logos, assets, and inbound payloads remain under /Library/Links in the same Workspace filesystem.
- Webpage Links are served as static documents with a restrictive CSP and without Papyrus-injected presentation styles or scripts.
- API Links serve approved JSON snapshots or explicitly bound durable workflows.
- Webhook Links may project inbound events into their creating Mastra session, but attached Action Executors create durable action proposals owned by the workspace approval ledger rather than the session lifecycle.
- A Webhook Link never directly authorizes an attached executor; enabled attachments resolve payload mappings/conditions into proposals that require the existing Papyrus.Action.Approve release boundary before the leased action worker can execute them.
- Webhook Links are the public dynamic-ingestion primitive; legacy Plugin connection and integration-scoped signal webhook routes are not exposed by the portal API.
- Recurring work is managed through session-scoped Agent tools; the public scheduler CRUD/page surface is not exposed.
- Webhook logo identity is snapshotted with the approved Link rather than loaded from an untrusted mutable URL.
- Kitesurf is optional validation only; it is not the hosting authority and is not configurable for government or disconnected profiles.
- nono applies kernel-backed filesystem authority and blocks network access for workspace command execution.
- AgentScript runs in Enclave STRICT and receives only Papyrus-brokered capabilities.
- Credential-like environment variables are stripped before workspace commands execute.
- Contract, workspace, frontend, secret, filename, and generated evidence drift checks run before commit and in CI.

## Evidence fingerprints

| Evidence source | Git blob |
| --- | --- |
${evidenceRows}

## Regeneration

Run \`pnpm compliance:generate\`. CI and the pre-commit hook run \`pnpm compliance:check\`.
`

const lock = staged('pnpm-lock.yaml') ?? readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')
const packageKeys = [...lock.matchAll(/^  ['"]?([^\n:]+@[^\n:]+)['"]?:\s*$/gm)].map((match) => match[1]).filter(Boolean)
const unique = [...new Set(packageKeys)].sort()
const sbom = {
  spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'papyrus-source-sbom',
  documentNamespace: `https://beaglabs.com/spdx/papyrus/${createHash('sha256').update(lock).digest('hex')}`,
  creationInfo: { created: new Date().toISOString(), creators: ['Tool: papyrus-compliance-generator'] },
  packages: unique.map((key, index) => ({
    name: key.replace(/@[^@]+$/, ''), SPDXID: `SPDXRef-Package-${index + 1}`, versionInfo: key.slice(key.lastIndexOf('@') + 1),
    downloadLocation: 'NOASSERTION', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'NOASSERTION', copyrightText: 'NOASSERTION',
  })),
}
mkdirSync(resolve(root, 'compliance'), { recursive: true })
writeFileSync(resolve(root, 'compliance/sbom.spdx.json'), JSON.stringify(sbom, null, 2) + '\n')

const generated = new Map([['compliance/contracts.manifest.json', contractText], ['compliance/ssp.md', sspText]])
if (check) {
  const stale = []
  for (const [path, content] of generated) if (staged(path) !== content) stale.push(path)
  if (stale.length) {
    console.error('Generated compliance evidence is stale:')
    for (const path of stale) console.error(`  - ${path}`)
    console.error('Run pnpm compliance:generate, review the changes, and stage them.')
    process.exit(1)
  }
} else {
  for (const [path, content] of generated) writeFileSync(resolve(root, path), content)
}
console.log(`[papyrus] compliance evidence ${check ? 'verified' : 'generated'}`)
