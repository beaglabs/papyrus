import { indexBlob, indexText } from './git.mjs'

const sources = [
  'packages/contracts/src/index.ts',
  'apps/server/src/agent/mastra/tools.ts',
  'apps/server/src/agent/mastra/workspace-agentfs.ts',
]
const expected = {
  formatVersion: 1,
  sources: sources.map((path) => ({ path, gitBlob: indexBlob(path) })),
}
const raw = indexText('compliance/contracts.manifest.json')
const errors = []
if (!raw) errors.push('compliance/contracts.manifest.json is missing')
else {
  try {
    const actual = JSON.parse(raw)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push('contract/schema manifest is stale; run pnpm compliance:generate and stage compliance/contracts.manifest.json')
  } catch (error) {
    errors.push(`compliance/contracts.manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (errors.length) {
  console.error('Contract/schema drift check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
