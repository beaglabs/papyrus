import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const check = process.argv.includes('--check')

function git(args: string[], allowFailure = false): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFailure) return undefined
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim()
    throw new Error(stderr ? `git ${args.join(' ')}: ${stderr}` : `git ${args.join(' ')} failed`)
  }
}

function indexText(path: string): string {
  const value = git(['show', `:${path}`], true)
  if (value === undefined) throw new Error(`Required repository file is missing from the index: ${path}`)
  return value
}

function indexBlob(path: string): string {
  const value = git(['rev-parse', `:${path}`], true)?.trim()
  if (!value) throw new Error(`Required repository file is missing from the index: ${path}`)
  return value
}

function indexPaths(): string[] {
  return (git(['ls-files', '-z']) ?? '').split('\0').filter(Boolean)
}

function exportedNames(text: string): string[] {
  const names = new Set<string>()
  const pattern = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of text.matchAll(pattern)) names.add(match[1]!)
  return [...names].sort()
}

const pluginContractSources = indexPaths()
  .filter((path) => /^contracts\/plugins\/(?!index\.ts$|types\.ts$)[^/]+\.ts$/.test(path))
  .sort()
const contractSources = [
  'contracts/index.ts',
  'contracts/src/index.ts',
  'contracts/plugins/types.ts',
  'contracts/plugins/index.ts',
  ...pluginContractSources,
  'acp-runtime/src/index.ts',
  'apps/server/src/mastra/tools.ts',
]
const contractManifest = {
  formatVersion: 1,
  sources: contractSources.map((path) => ({
    path,
    gitBlob: indexBlob(path),
    exports: exportedNames(indexText(path)),
  })),
}
const contractManifestText = `${JSON.stringify(contractManifest, null, 2)}\n`

const evidencePaths = [
  'apps/server/src/config.ts',
  'apps/server/src/policy.ts',
  'apps/server/src/audit.ts',
  'apps/server/src/catalog.ts',
  'apps/server/src/mastra/authorization.ts',
  'apps/server/src/mastra/sandbox.ts',
  'apps/server/src/mastra/workspace.ts',
  'apps/server/src/mastra/tools.ts',
  'contracts/src/index.ts',
  'contracts/plugins/index.ts',
  'acp-runtime/src/index.ts',
]
const evidenceRows = evidencePaths.map((path) => `| \`${path}\` | \`${indexBlob(path)}\` |`).join('\n')

const ssp = `# Papyrus System Security Plan (Repository-Derived)\n\n> Generated control-evidence artifact. This document is not an authorization decision, certification, or claim that Papyrus satisfies every control in a regulatory framework.\n\n## System identification and boundary\n\nPapyrus is a secure agent gateway/control plane for regulated and disconnected environments. The repository boundary includes the TypeScript web application, server, ACP runtime contract, shared application contracts, deployment manifests, and the governed session workspace implementation.\n\nSupported deployment profiles are \`commercial\`, \`government-il4\`, and \`government-il6\`. Persistent deployments are expected to provide production transport, identity, runtime, and licensing controls defined by the server configuration.\n\n## Identity and transport\n\n- Commercial deployments use OIDC or an authenticated trusted identity proxy for remote access.\n- Government profiles reject OIDC and use CAC/PIV-compatible mTLS identity paths.\n- Remote gateway listeners require mTLS; development tokens are restricted to local/loopback use.\n- Persistent government profiles require a FIPS-enabled Node/OpenSSL runtime.\n\n## Authorization and tool governance\n\n- Authorization is implemented with a fixed Cedar policy and explicit role/action mappings.\n- Session and environment access is scoped to ownership/assignment.\n- Runtime tools are mapped through an exact allowlist; unknown tools have no policy mapping.\n- Browser and workspace actions remain explicit policy actions rather than implicit agent capabilities.\n\n## Session workspace and execution isolation\n\n- Session file access uses a contained workspace filesystem.\n- Command execution is exposed only when an OS isolation backend is available and passes a runtime probe.\n- Seatbelt uses deny-by-default rules and denies network access.\n- Bubblewrap unshares namespaces and binds only the session workspace read/write.\n- Workspace command networking is disabled, filesystem delete is disabled, and read-before-write is required.\n- Host-launched LSP inspection remains disabled until it can share the command isolation boundary.\n\n## Audit and integrity\n\nPapyrus records authorization/audit events in an append-only hash chain. Each event includes its previous event hash and the fixed policy version, providing tamper-evident ordering for exported audit evidence.\n\n## Supply-chain and change-control evidence\n\n- pnpm is the canonical package manager and the lockfile is frozen in CI.\n- \`compliance/sbom.spdx.json\` is generated from the staged pnpm lockfile and workspace package manifests.\n- \`compliance/contracts.manifest.json\` fingerprints the public shared-contract and ACP-runtime surfaces.\n- Local pre-commit guardrails scan staged changes for secrets, unsafe workspace escapes, debug junk, contract drift, filename collisions, frontend accessibility regressions, and Markdown rendering fixtures.\n\n## Evidence fingerprints\n\nThe values below are Git blob IDs from the candidate Git index. A change to a security-boundary source changes this generated SSP and requires the updated evidence artifact to be staged.\n\n| Evidence source | Git blob |\n| --- | --- |\n${evidenceRows}\n\n## Regeneration\n\nRun \`pnpm compliance:generate\` to regenerate this SSP, the contract manifest, and the SPDX SBOM. Pre-commit and CI use \`pnpm compliance:check\` to fail when tracked compliance evidence is stale.\n`

function packageKeyParts(key: string): { name: string; version: string } | undefined {
  // pnpm appends peer-resolution context in parentheses. Strip the entire suffix
  // from the first peer-context delimiter so nested peer groups cannot leak an
  // inner @version into the package-name/version split.
  const peerContext = key.indexOf('(')
  const base = peerContext === -1 ? key : key.slice(0, peerContext)
  const at = base.lastIndexOf('@')
  if (at <= 0 || at === base.length - 1) return undefined
  return { name: base.slice(0, at), version: base.slice(at + 1) }
}

function spdxId(seed: string): string {
  const slug = seed.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'package'
  return `SPDXRef-${slug}-${createHash('sha256').update(seed).digest('hex').slice(0, 10)}`
}

const lockText = indexText('pnpm-lock.yaml')
const lock = parse(lockText) as { packages?: Record<string, unknown> }
const packageManifestPaths = indexPaths().filter((path) =>
  path === 'package.json' ||
  /^apps\/[^/]+\/package\.json$/.test(path) ||
  /^(?:contracts|acp-runtime)\/package\.json$/.test(path))
const workspacePackages = packageManifestPaths.map((path) => {
  const manifest = JSON.parse(indexText(path)) as { name?: string; version?: string }
  return {
    path,
    name: manifest.name ?? path,
    version: manifest.version ?? '0.0.0',
  }
})

const externalByKey = new Map<string, { name: string; version: string }>()
for (const key of Object.keys(lock.packages ?? {})) {
  const parts = packageKeyParts(key)
  if (!parts) continue
  externalByKey.set(`${parts.name}@${parts.version}`, parts)
}
const externalPackages = [...externalByKey.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))

const sbomPackages = [
  ...workspacePackages.map((pkg) => ({
    name: pkg.name,
    SPDXID: spdxId(`workspace:${pkg.path}:${pkg.name}@${pkg.version}`),
    versionInfo: pkg.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    supplier: 'Organization: Beag Labs, Inc.',
    primaryPackagePurpose: 'APPLICATION',
  })),
  ...externalPackages.map((pkg) => ({
    name: pkg.name,
    SPDXID: spdxId(`dependency:${pkg.name}@${pkg.version}`),
    versionInfo: pkg.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    primaryPackagePurpose: 'LIBRARY',
  })),
]
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: 'papyrus-source-sbom',
  documentNamespace: `https://beaglabs.com/spdx/papyrus/${createHash('sha256').update(lockText).digest('hex')}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ['Tool: papyrus-compliance-generator'],
  },
  packages: sbomPackages,
  relationships: workspacePackages.map((pkg) => ({
    spdxElementId: 'SPDXRef-DOCUMENT',
    relationshipType: 'DESCRIBES',
    relatedSpdxElement: spdxId(`workspace:${pkg.path}:${pkg.name}@${pkg.version}`),
  })),
}
const sbomText = `${JSON.stringify(sbom, null, 2)}\n`

const complianceDir = resolve(root, 'compliance')
mkdirSync(complianceDir, { recursive: true })
const generated = new Map<string, string>([
  ['compliance/ssp.md', ssp],
  ['compliance/contracts.manifest.json', contractManifestText],
  ['compliance/sbom.spdx.json', sbomText],
])
for (const [path, content] of generated) {
  // Check mode must not overwrite tracked evidence or destroy an unstaged review edit.
  // The ignored SBOM is still emitted so CI can upload it as a build artifact.
  if (!check || path === 'compliance/sbom.spdx.json') writeFileSync(resolve(root, path), content)
}

if (check) {
  const stale: string[] = []
  for (const path of ['compliance/ssp.md', 'compliance/contracts.manifest.json']) {
    const staged = git(['show', `:${path}`], true)
    if (staged !== generated.get(path)) stale.push(path)
  }
  if (stale.length) {
    console.error('Generated compliance evidence is stale:')
    for (const path of stale) console.error(`  - ${path}`)
    console.error('Review the regenerated files, then git add compliance/ssp.md compliance/contracts.manifest.json and commit again.')
    process.exit(1)
  }
}

console.log(`[papyrus] compliance artifacts generated${check ? ' and checked' : ''}`)
