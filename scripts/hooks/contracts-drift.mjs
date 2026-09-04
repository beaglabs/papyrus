import { indexBlob, indexText, stagedPaths, trackedPaths } from './git.mjs'

const contractSources = [
  'packages/contracts/src/index.ts',
  'packages/acp-runtime/src/index.ts',
  'apps/server/src/mastra/tools.ts',
]

function exportedNames(text) {
  const names = new Set()
  const pattern = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of text.matchAll(pattern)) names.add(match[1])
  return [...names].sort()
}

const expected = contractSources.map((path) => {
  const text = indexText(path)
  const gitBlob = indexBlob(path)
  if (text === undefined || !gitBlob) throw new Error(`Contract source is missing from the index: ${path}`)
  return { path, gitBlob, exports: exportedNames(text) }
})

const manifestText = indexText('compliance/contracts.manifest.json')
const errors = []
if (manifestText === undefined) {
  errors.push('compliance/contracts.manifest.json is missing; run pnpm compliance:generate and stage it')
} else {
  try {
    const manifest = JSON.parse(manifestText)
    if (manifest.formatVersion !== 1) errors.push('compliance/contracts.manifest.json has an unsupported formatVersion')
    if (JSON.stringify(manifest.sources) !== JSON.stringify(expected)) {
      errors.push('contract/schema manifest is stale; run pnpm compliance:generate and stage compliance/contracts.manifest.json')
    }
  } catch (error) {
    errors.push(`compliance/contracts.manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const path of trackedPaths().filter((path) => path.endsWith('/package.json') || path === 'package.json')) {
  const text = indexText(path)
  if (text === undefined) continue
  try {
    const manifest = JSON.parse(text)
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const version = manifest[section]?.['@papyrus/contracts']
      if (version !== undefined && version !== 'workspace:*') errors.push(`${path}: @papyrus/contracts must use workspace:* (${section})`)
      const runtimeVersion = manifest[section]?.['@papyrus/acp-runtime']
      if (runtimeVersion !== undefined && runtimeVersion !== 'workspace:*') errors.push(`${path}: @papyrus/acp-runtime must use workspace:* (${section})`)
    }
  } catch {
    // Package JSON validity is covered by install/typecheck; avoid duplicate noise.
  }
}

for (const path of stagedPaths().filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
  const text = indexText(path) ?? ''
  if (/['"](?:@papyrus\/contracts\/|@papyrus\/acp-runtime\/|\.\.\/.*packages\/(?:contracts|acp-runtime)\/src)/.test(text)) {
    errors.push(`${path}: import contract packages only through their public package exports`)
  }
}

if (errors.length) {
  console.error('Contract/schema drift check failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  process.exit(1)
}
