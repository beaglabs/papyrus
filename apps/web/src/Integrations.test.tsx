import { describe, expect, it } from 'vitest'
import type { IntegrationCatalogEntry, IntegrationConfiguration } from '@papyrus/contracts'
import { buildCanonicalObservationExample, buildNativeObservationExample, buildObservationCurlCommand, buildObservationTailCommand } from './Integrations.js'

const entry: IntegrationCatalogEntry = {
  id: 'zeek', name: 'Zeek', vendor: 'Open source', description: 'Network evidence', integrationClass: 'evidence_source',
  authority: 'read_only', risk: 'low', capabilities: [], evidenceTypes: ['NetworkConnection'], syncMode: 'push',
  authSchemes: ['mTLS'], supportedProfiles: ['gcc'], licenseFeature: 'security-connectors', accent: '#ffd36e', initials: 'ZK',
  observationProtocol: {
    acceptsCanonicalTerrain: true,
    schemas: [{
      id: 'zeek.conn@1', label: 'Zeek connection', description: 'One conn.log record', evidenceType: 'NetworkConnection',
      example: { uid: 'C1', 'id.orig_h': '10.0.0.12', 'id.resp_h': '10.0.0.8' },
      canonicalExample: {
        evidenceType: 'NetworkConnection', subject: 'connection:C1',
        terrain: {
          entities: [{ externalId: 'ip:10.0.0.12', kind: 'IPAddress', label: '10.0.0.12' }, { externalId: 'ip:10.0.0.8', kind: 'IPAddress', label: '10.0.0.8' }],
          relationships: [{ kind: 'connected_to', sourceExternalId: 'ip:10.0.0.12', targetExternalId: 'ip:10.0.0.8' }],
        },
      },
    }],
  },
}

const integration: IntegrationConfiguration = {
  id: 'integration-1042', catalogId: 'zeek', name: 'Zeek East', integrationClass: 'evidence_source', authority: 'read_only', risk: 'low',
  state: 'active', scope: 'east enclave', settings: {}, health: 'healthy', createdByOid: 'owner', createdAt: '2026-09-02T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z', version: 4,
}

describe('Observation API push setup', () => {
  it('builds a versioned native envelope without a caller-controlled source identity', () => {
    const example = buildNativeObservationExample(entry, 'zeek.conn@1')
    expect(example).toMatchObject({ schema: 'zeek.conn@1', payload: { uid: 'C1' } })
    expect(example).not.toHaveProperty('source')
    expect(example).not.toHaveProperty('terrain')
  })

  it('generates a command bound to the configured integration route', () => {
    const command = buildObservationCurlCommand(integration, buildNativeObservationExample(entry, 'zeek.conn@1'))
    expect(command).toContain('/api/integrations/integration-1042/observations')
    expect(command).toContain('Authorization: Bearer $PAPYRUS_ENTRA_TOKEN')
    expect(command).toContain('PAPYRUS_DAEMON_ORIGIN')
    expect(command).toContain('"schema": "zeek.conn@1"')
  })

  it('generates a continuous NDJSON bridge into the daemon API', () => {
    const command = buildObservationTailCommand(integration, 'zeek.conn@1')
    expect(command).toContain('tail -Fn0 "$SOURCE_NDJSON"')
    expect(command).toContain('SOURCE_NDJSON=/opt/zeek/logs/current/conn.log')
    expect(command).toContain('--arg schema "zeek.conn@1"')
    expect(command).toContain('/api/integrations/integration-1042/observations')
    expect(command).not.toContain('papyrus.customer.example')
  })

  it('shows the equivalent pre-normalized canonical projection', () => {
    const example = buildCanonicalObservationExample(entry, integration, 'zeek.conn@1')
    expect(example).not.toHaveProperty('schema')
    expect(example).toMatchObject({
      evidenceType: 'NetworkConnection', subject: 'connection:C1',
      terrain: { entities: [{ externalId: 'ip:10.0.0.12' }, { externalId: 'ip:10.0.0.8' }] },
    })
  })
})
