import { describe, expect, it } from 'vitest'
import { normalizeSourceRecord, SOURCE_SCHEMAS } from '../src/agent/source-profiles.js'

describe('Observation API source profiles', () => {
  for (const [catalogId, schemas] of Object.entries(SOURCE_SCHEMAS)) {
    for (const schema of schemas) {
      it(`normalizes ${catalogId} ${schema.id}`, () => {
        const normalized = normalizeSourceRecord(catalogId, schema.id, schema.example, `${schema.id}-example`)
        expect(normalized.evidenceType).toBe(schema.evidenceType)
        expect(normalized.subject).toBeTruthy()
        expect(normalized.terrain.entities.length).toBeGreaterThan(0)
        const entityIds = new Set(normalized.terrain.entities.map((entity) => entity.externalId))
        for (const relationship of normalized.terrain.relationships ?? []) {
          expect(entityIds.has(relationship.sourceExternalId)).toBe(true)
          expect(entityIds.has(relationship.targetExternalId)).toBe(true)
        }
      })
    }
  }

  it('does not allow a schema to impersonate another configured source', () => {
    const payload = SOURCE_SCHEMAS.suricata![0]!.example
    expect(() => normalizeSourceRecord('zeek', 'suricata.eve.alert@1', payload, 'record-1')).toThrow(/not supported by zeek/)
  })
})
