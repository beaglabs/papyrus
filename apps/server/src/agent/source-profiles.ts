import type {
  ObservationProtocolProfile,
  ObservationSchemaProfile,
  ObservationInput,
  TerrainEntityInput,
  TerrainRelationshipInput,
} from '@papyrus/contracts'

export class SourceNormalizationError extends Error {}

interface NormalizedObservation {
  evidenceType: string
  subject: string
  terrain: NonNullable<ObservationInput['terrain']>
}
type Normalizer = (payload: Record<string, unknown>, sourceRecordId: string) => NormalizedObservation

function schema(id: string, label: string, description: string, evidenceType: string, example: Record<string, unknown>): ObservationSchemaProfile {
  return { id, label, description, evidenceType, example }
}

export const SOURCE_SCHEMAS: Record<string, ObservationSchemaProfile[]> = {
  'microsoft-entra': [
    schema('entra.user@1', 'Entra user', 'A Microsoft Graph user object.', 'Identity', {
      id: '2f2a7f93-35bd-4f73-b42b-50f98658f033', displayName: 'Alex Morgan', userPrincipalName: 'alex@example.mil', accountEnabled: true,
    }),
    schema('entra.group-membership@1', 'Entra group membership', 'A group-to-member relationship exported from Microsoft Graph.', 'TrustRelationship', {
      groupId: 'group-security-operations', groupDisplayName: 'Security Operations', memberId: '2f2a7f93-35bd-4f73-b42b-50f98658f033', memberDisplayName: 'Alex Morgan',
    }),
  ],
  'defender-xdr': [
    schema('defender.alert@1', 'Defender alert', 'A Defender XDR alert with optional device identity.', 'Alert', {
      id: 'da637312284012345678', title: 'Suspicious process behavior', severity: 'medium', status: 'new', deviceId: 'device-1042', deviceName: 'WS-1042',
    }),
  ],
  'microsoft-sentinel': [
    schema('sentinel.incident@1', 'Sentinel incident', 'A Sentinel incident record or Logic App projection.', 'Incident', {
      id: 'incident-1042', title: 'Multiple correlated alerts', severity: 'High', status: 'New', incidentNumber: 1042,
    }),
  ],
  zeek: [
    schema('zeek.conn@1', 'Zeek connection', 'One JSON record from Zeek conn.log.', 'NetworkConnection', {
      uid: 'CTo78A11gLkU', 'id.orig_h': '10.0.0.12', 'id.orig_p': 51822, 'id.resp_h': '10.0.0.8', 'id.resp_p': 443, proto: 'tcp', service: 'ssl',
    }),
  ],
  suricata: [
    schema('suricata.eve.alert@1', 'Suricata EVE alert', 'An alert event from Suricata eve.json.', 'Alert', {
      event_type: 'alert', flow_id: 204851144702544, src_ip: '10.0.0.12', src_port: 51822, dest_ip: '10.0.0.8', dest_port: 443, proto: 'TCP',
      alert: { signature_id: 2100498, signature: 'Potentially Bad Traffic', severity: 2 },
    }),
    schema('suricata.eve.flow@1', 'Suricata EVE flow', 'A network flow event from Suricata eve.json.', 'NetworkFlow', {
      event_type: 'flow', flow_id: 204851144702544, src_ip: '10.0.0.12', src_port: 51822, dest_ip: '10.0.0.8', dest_port: 443, proto: 'TCP',
    }),
  ],
  sysmon: [
    schema('sysmon.network-connect@1', 'Sysmon network connection', 'A normalized Sysmon Event ID 3 record.', 'NetworkConnection', {
      EventID: 3, Computer: 'WS-1042.example.mil', ProcessGuid: '{47ab-1042}', Image: 'C:\\Windows\\System32\\curl.exe', SourceIp: '10.0.0.12', DestinationIp: '10.0.0.8', DestinationPort: 443,
    }),
    schema('sysmon.process-create@1', 'Sysmon process creation', 'A normalized Sysmon Event ID 1 record.', 'Process', {
      EventID: 1, Computer: 'WS-1042.example.mil', ProcessGuid: '{47ab-1042}', Image: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', User: 'EXAMPLE\\analyst',
    }),
  ],
  'dns-observation': [
    schema('dns.response@1', 'DNS response', 'A resolver-independent DNS response projection.', 'DNSResolution', {
      query: 'service.example.mil', queryType: 'A', answers: ['10.0.0.8'], responseCode: 'NOERROR', resolver: 'resolver-1',
    }),
  ],
  'asset-inventory': [
    schema('asset.device@1', 'Inventory device', 'A device record from a CMDB or asset inventory export.', 'AssetInventory', {
      id: 'asset-1042', hostname: 'WS-1042', operatingSystem: 'Windows 11', ipAddresses: ['10.0.0.12'], owner: 'Security Operations',
    }),
  ],
}

export function observationProtocol(catalogId: string, acceptsCanonicalTerrain = true): ObservationProtocolProfile {
  return {
    acceptsCanonicalTerrain,
    schemas: (SOURCE_SCHEMAS[catalogId] ?? []).map((profile) => ({
      ...profile,
      canonicalExample: normalizeSourceRecord(catalogId, profile.id, profile.example, `${profile.id}-canonical-example`),
    })),
  }
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SourceNormalizationError(`${path} must be a non-empty string`)
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const item = value[key]
  return item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
}

function address(value: string): TerrainEntityInput {
  return { externalId: `ip:${value}`, kind: 'IPAddress', label: value }
}

function flowTerrain(sourceRecordId: string, fields: {
  source: string
  target: string
  sourcePort?: unknown
  targetPort?: unknown
  protocol?: unknown
  relationshipKind: string
}): NonNullable<ObservationInput['terrain']> {
  const source = requiredText(fields.source, 'payload source address')
  const target = requiredText(fields.target, 'payload destination address')
  return {
    entities: [address(source), address(target)],
    relationships: [{
      externalId: `observation:${sourceRecordId}`,
      kind: fields.relationshipKind,
      sourceExternalId: `ip:${source}`,
      targetExternalId: `ip:${target}`,
      attributes: {
        ...(fields.sourcePort === undefined ? {} : { sourcePort: fields.sourcePort }),
        ...(fields.targetPort === undefined ? {} : { destinationPort: fields.targetPort }),
        ...(fields.protocol === undefined ? {} : { protocol: fields.protocol }),
      },
    }],
  }
}

const NORMALIZERS: Record<string, Normalizer> = {
  'entra.user@1': (payload) => {
    const id = requiredText(payload.id, 'payload.id')
    const label = optionalText(payload.displayName) ?? optionalText(payload.userPrincipalName) ?? id
    return {
      evidenceType: 'Identity', subject: `identity:${id}`,
      terrain: { entities: [{ externalId: `identity:${id}`, kind: 'Identity', label, attributes: {
        ...(optionalText(payload.userPrincipalName) ? { userPrincipalName: optionalText(payload.userPrincipalName) } : {}),
        ...(typeof payload.accountEnabled === 'boolean' ? { accountEnabled: payload.accountEnabled } : {}),
      } }], relationships: [] },
    }
  },
  'entra.group-membership@1': (payload, sourceRecordId) => {
    const groupId = requiredText(payload.groupId, 'payload.groupId')
    const memberId = requiredText(payload.memberId, 'payload.memberId')
    const groupExternalId = `group:${groupId}`
    const memberExternalId = `identity:${memberId}`
    return {
      evidenceType: 'TrustRelationship', subject: groupExternalId,
      terrain: {
        entities: [
          { externalId: groupExternalId, kind: 'Group', label: optionalText(payload.groupDisplayName) ?? groupId },
          { externalId: memberExternalId, kind: 'Identity', label: optionalText(payload.memberDisplayName) ?? memberId },
        ],
        relationships: [{ externalId: `observation:${sourceRecordId}`, kind: 'member_of', sourceExternalId: memberExternalId, targetExternalId: groupExternalId }],
      },
    }
  },
  'defender.alert@1': (payload, sourceRecordId) => {
    const id = requiredText(payload.id, 'payload.id')
    const alertId = `alert:defender:${id}`
    const deviceId = optionalText(payload.deviceId) ?? optionalText(payload.machineId)
    const entities: TerrainEntityInput[] = [{
      externalId: alertId, kind: 'Alert', label: optionalText(payload.title) ?? id,
      attributes: { ...(optionalText(payload.severity) ? { severity: optionalText(payload.severity) } : {}), ...(optionalText(payload.status) ? { status: optionalText(payload.status) } : {}) },
    }]
    const relationships: TerrainRelationshipInput[] = []
    if (deviceId) {
      const deviceExternalId = `device:${deviceId}`
      entities.push({ externalId: deviceExternalId, kind: 'Device', label: optionalText(payload.deviceName) ?? deviceId })
      relationships.push({ externalId: `observation:${sourceRecordId}`, kind: 'observed_on', sourceExternalId: alertId, targetExternalId: deviceExternalId })
    }
    return { evidenceType: 'Alert', subject: alertId, terrain: { entities, relationships } }
  },
  'sentinel.incident@1': (payload) => {
    const properties = nested(payload, 'properties')
    const id = requiredText(payload.id ?? payload.name, 'payload.id')
    const externalId = `incident:sentinel:${id}`
    return {
      evidenceType: 'Incident', subject: externalId,
      terrain: { entities: [{
        externalId, kind: 'Incident', label: optionalText(payload.title) ?? optionalText(properties.title) ?? id,
        attributes: {
          ...(optionalText(payload.severity) ?? optionalText(properties.severity) ? { severity: optionalText(payload.severity) ?? optionalText(properties.severity) } : {}),
          ...(optionalText(payload.status) ?? optionalText(properties.status) ? { status: optionalText(payload.status) ?? optionalText(properties.status) } : {}),
          ...(payload.incidentNumber === undefined && properties.incidentNumber === undefined ? {} : { incidentNumber: payload.incidentNumber ?? properties.incidentNumber }),
        },
      }], relationships: [] },
    }
  },
  'zeek.conn@1': (payload, sourceRecordId) => {
    const source = requiredText(payload['id.orig_h'], 'payload.id.orig_h')
    const target = requiredText(payload['id.resp_h'], 'payload.id.resp_h')
    return {
      evidenceType: 'NetworkConnection', subject: `connection:${optionalText(payload.uid) ?? sourceRecordId}`,
      terrain: flowTerrain(sourceRecordId, {
        source, target, sourcePort: payload['id.orig_p'], targetPort: payload['id.resp_p'], protocol: payload.proto, relationshipKind: 'connected_to',
      }),
    }
  },
  'suricata.eve.alert@1': (payload, sourceRecordId) => {
    const source = requiredText(payload.src_ip, 'payload.src_ip')
    const target = requiredText(payload.dest_ip, 'payload.dest_ip')
    if (payload.event_type !== 'alert') throw new SourceNormalizationError('payload.event_type must be alert')
    const alert = nested(payload, 'alert')
    const alertId = `alert:suricata:${String(payload.flow_id ?? sourceRecordId)}:${String(alert.signature_id ?? 'unknown')}`
    const network = flowTerrain(sourceRecordId, {
      source, target, sourcePort: payload.src_port, targetPort: payload.dest_port, protocol: payload.proto, relationshipKind: 'triggered_alert',
    })
    return {
      evidenceType: 'Alert', subject: alertId,
      terrain: {
        entities: [...network.entities, { externalId: alertId, kind: 'Alert', label: optionalText(alert.signature) ?? 'Suricata alert', attributes: {
          ...(alert.signature_id === undefined ? {} : { signatureId: alert.signature_id }), ...(alert.severity === undefined ? {} : { severity: alert.severity }),
        } }],
        relationships: [
          ...(network.relationships ?? []),
          { externalId: `alert-source:${sourceRecordId}`, kind: 'originated_from', sourceExternalId: alertId, targetExternalId: `ip:${source}` },
          { externalId: `alert-target:${sourceRecordId}`, kind: 'targeted', sourceExternalId: alertId, targetExternalId: `ip:${target}` },
        ],
      },
    }
  },
  'suricata.eve.flow@1': (payload, sourceRecordId) => {
    if (payload.event_type !== 'flow') throw new SourceNormalizationError('payload.event_type must be flow')
    const source = requiredText(payload.src_ip, 'payload.src_ip')
    const target = requiredText(payload.dest_ip, 'payload.dest_ip')
    return {
      evidenceType: 'NetworkFlow', subject: `flow:${String(payload.flow_id ?? sourceRecordId)}`,
      terrain: flowTerrain(sourceRecordId, {
        source, target, sourcePort: payload.src_port, targetPort: payload.dest_port, protocol: payload.proto, relationshipKind: 'communicated_with',
      }),
    }
  },
  'sysmon.network-connect@1': (payload, sourceRecordId) => {
    if (Number(payload.EventID) !== 3) throw new SourceNormalizationError('payload.EventID must be 3')
    const source = requiredText(payload.SourceIp, 'payload.SourceIp')
    const target = requiredText(payload.DestinationIp, 'payload.DestinationIp')
    const computer = requiredText(payload.Computer, 'payload.Computer')
    const deviceId = `device:${computer.toLowerCase()}`
    const processId = `process:${optionalText(payload.ProcessGuid) ?? `${computer}:${sourceRecordId}`}`
    const network = flowTerrain(sourceRecordId, { source, target, targetPort: payload.DestinationPort, protocol: payload.Protocol, relationshipKind: 'connected_to' })
    return {
      evidenceType: 'NetworkConnection', subject: processId,
      terrain: {
        entities: [
          ...network.entities,
          { externalId: deviceId, kind: 'Device', label: computer },
          { externalId: processId, kind: 'Process', label: optionalText(payload.Image) ?? 'Unknown process' },
        ],
        relationships: [
          ...(network.relationships ?? []),
          { externalId: `process-device:${sourceRecordId}`, kind: 'runs_on', sourceExternalId: processId, targetExternalId: deviceId },
          { externalId: `process-target:${sourceRecordId}`, kind: 'connected_to', sourceExternalId: processId, targetExternalId: `ip:${target}` },
        ],
      },
    }
  },
  'sysmon.process-create@1': (payload, sourceRecordId) => {
    if (Number(payload.EventID) !== 1) throw new SourceNormalizationError('payload.EventID must be 1')
    const computer = requiredText(payload.Computer, 'payload.Computer')
    const processId = `process:${optionalText(payload.ProcessGuid) ?? `${computer}:${sourceRecordId}`}`
    const deviceId = `device:${computer.toLowerCase()}`
    return {
      evidenceType: 'Process', subject: processId,
      terrain: {
        entities: [
          { externalId: processId, kind: 'Process', label: optionalText(payload.Image) ?? 'Unknown process', attributes: { ...(optionalText(payload.User) ? { user: optionalText(payload.User) } : {}) } },
          { externalId: deviceId, kind: 'Device', label: computer },
        ],
        relationships: [{ externalId: `observation:${sourceRecordId}`, kind: 'runs_on', sourceExternalId: processId, targetExternalId: deviceId }],
      },
    }
  },
  'dns.response@1': (payload, sourceRecordId) => {
    const query = requiredText(payload.query, 'payload.query').toLowerCase().replace(/\.$/, '')
    if (!Array.isArray(payload.answers)) throw new SourceNormalizationError('payload.answers must be an array')
    const answers = payload.answers.map((item, index) => requiredText(item, `payload.answers[${index}]`))
    const domainId = `domain:${query}`
    return {
      evidenceType: 'DNSResolution', subject: domainId,
      terrain: {
        entities: [{ externalId: domainId, kind: 'Domain', label: query }, ...answers.map(address)],
        relationships: answers.map((answer, index) => ({
          externalId: `observation:${sourceRecordId}:${index}`, kind: 'resolved_to', sourceExternalId: domainId, targetExternalId: `ip:${answer}`,
          attributes: { ...(optionalText(payload.queryType) ? { queryType: optionalText(payload.queryType) } : {}), ...(optionalText(payload.resolver) ? { resolver: optionalText(payload.resolver) } : {}) },
        })),
      },
    }
  },
  'asset.device@1': (payload, sourceRecordId) => {
    const id = requiredText(payload.id ?? payload.hostname, 'payload.id')
    const hostname = optionalText(payload.hostname) ?? id
    const deviceId = `device:${id}`
    const addresses = payload.ipAddresses === undefined ? [] : Array.isArray(payload.ipAddresses)
      ? payload.ipAddresses.map((item, index) => requiredText(item, `payload.ipAddresses[${index}]`))
      : (() => { throw new SourceNormalizationError('payload.ipAddresses must be an array') })()
    return {
      evidenceType: 'AssetInventory', subject: deviceId,
      terrain: {
        entities: [
          { externalId: deviceId, kind: 'Device', label: hostname, attributes: {
            ...(optionalText(payload.operatingSystem) ? { operatingSystem: optionalText(payload.operatingSystem) } : {}),
            ...(optionalText(payload.owner) ? { owner: optionalText(payload.owner) } : {}),
          } },
          ...addresses.map(address),
        ],
        relationships: addresses.map((item, index) => ({
          externalId: `observation:${sourceRecordId}:${index}`, kind: 'has_address', sourceExternalId: deviceId, targetExternalId: `ip:${item}`,
        })),
      },
    }
  },
}

export function normalizeSourceRecord(catalogId: string, schemaId: string, payload: Record<string, unknown>, sourceRecordId: string): NormalizedObservation {
  const allowed = SOURCE_SCHEMAS[catalogId] ?? []
  if (!allowed.some((candidate) => candidate.id === schemaId)) {
    throw new SourceNormalizationError(`Schema ${schemaId} is not supported by ${catalogId}`)
  }
  const normalizer = NORMALIZERS[schemaId]
  if (!normalizer) throw new SourceNormalizationError(`Schema ${schemaId} does not have a deterministic normalizer`)
  return normalizer(payload, sourceRecordId)
}
