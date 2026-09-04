import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { PLUGIN_CONTRACTS, pluginContractById, validatePluginContract } from '../dist/plugins/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const contractsRoot = dirname(here)
const pluginDir = join(contractsRoot, 'plugins')

function parsedFixture(relativePath) {
  return JSON.parse(readFileSync(join(contractsRoot, relativePath), 'utf8'))
}

test('every plugin source file is registered exactly once', () => {
  const sourceIds = readdirSync(pluginDir).filter((name) => name.endsWith('.ts') && !['index.ts', 'types.ts'].includes(name)).map((name) => name.slice(0, -3)).sort()
  const registeredIds = PLUGIN_CONTRACTS.map((contract) => contract.id).sort()
  assert.deepEqual(registeredIds, sourceIds)
  assert.equal(new Set(registeredIds).size, registeredIds.length)
})

test('every plugin contract satisfies cross-plugin security and conformance invariants', () => {
  for (const contract of PLUGIN_CONTRACTS) assert.deepEqual(validatePluginContract(contract), [], contract.id)
})

test('replay fixtures are valid JSON and cover every declared source schema', () => {
  const schemaIds = []
  for (const contract of PLUGIN_CONTRACTS) {
    const parsedByFixture = new Map()
    for (const fixture of contract.replayFixtures ?? []) {
      assert.doesNotThrow(() => parsedFixture(fixture), `${contract.id}: ${fixture}`)
      parsedByFixture.set(fixture, parsedFixture(fixture))
    }
    for (const schema of contract.observationSchemas ?? []) {
      schemaIds.push(schema.id)
      const parsed = parsedByFixture.get(schema.fixture) ?? parsedFixture(schema.fixture)
      const records = Array.isArray(parsed) ? parsed : [parsed]
      assert.ok(records.some((record) => record?.schema === schema.id), `${contract.id}: fixture does not cover ${schema.id}`)
    }
  }
  assert.equal(new Set(schemaIds).size, schemaIds.length, 'source schema ids must be globally unique')
})

test('critical plugin boundaries remain explicit', () => {
  const exchange = pluginContractById('exchange-email')
  assert.equal(exchange?.syncMode, 'pull')
  assert.equal(exchange?.authority, 'bidirectional')
  assert.equal(exchange?.security.actionApproval, 'required')
  assert.equal(exchange?.conformance.live, 'required')
  const zeek = pluginContractById('zeek')
  assert.deepEqual(zeek?.observationSchemas?.map((schema) => schema.id), ['zeek.conn@1'])
  assert.equal(zeek?.security.outboundNetwork, 'none')
  assert.deepEqual(pluginContractById('suricata')?.observationSchemas?.map((schema) => schema.id), ['suricata.eve.alert@1', 'suricata.eve.flow@1'])
  assert.deepEqual(pluginContractById('sysmon')?.observationSchemas?.map((schema) => schema.id), ['sysmon.network-connect@1', 'sysmon.process-create@1'])
  assert.deepEqual(pluginContractById('dns-observation')?.observationSchemas?.map((schema) => schema.id), ['dns.response@1'])
  const firewall = pluginContractById('firewall-executor')
  assert.equal(firewall?.risk, 'critical')
  assert.equal(firewall?.authority, 'controlled_actions')
  assert.equal(firewall?.security.actionApproval, 'required')
})

test('configuration contracts never ask for inline secret material', () => {
  const forbidden = /(?:password|secret|token|private.?key|api.?key)/i
  for (const contract of PLUGIN_CONTRACTS) for (const setting of contract.requiredSettings ?? []) assert.doesNotMatch(setting, forbidden, `${contract.id}: ${setting}`)
})
