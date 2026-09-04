import assert from 'node:assert/strict'
import test from 'node:test'
import { APPROVED_SOURCE_KINDS, PLUGIN_CONTRACTS, PROFILES, ROLES, SESSION_SURFACES } from '../dist/index.js'

function assertUniqueNonEmpty(values, label) {
  assert.ok(values.length > 0, `${label} must not be empty`)
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`)
}
test('shared enumerations remain unique and non-empty', () => {
  assertUniqueNonEmpty(ROLES, 'ROLES')
  assertUniqueNonEmpty(PROFILES, 'PROFILES')
  assertUniqueNonEmpty(SESSION_SURFACES, 'SESSION_SURFACES')
  assertUniqueNonEmpty(APPROVED_SOURCE_KINDS, 'APPROVED_SOURCE_KINDS')
})
test('package root exports the plugin contract registry', () => {
  assert.equal(PLUGIN_CONTRACTS.length, 15)
  assert.ok(PLUGIN_CONTRACTS.some((contract) => contract.id === 'exchange-email'))
  assert.ok(PLUGIN_CONTRACTS.some((contract) => contract.id === 'zeek'))
})
