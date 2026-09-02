import type { DeploymentProfile, IntegrationCatalogEntry } from '@papyrus/contracts'

const CONNECTED: DeploymentProfile[] = ['commercial', 'government-il4', 'government-il6', 'gcc', 'gcch', 'dod', 'restricted']
const ALL: DeploymentProfile[] = [...CONNECTED, 'disconnected']

export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = [
  {
    id: 'observation-api', name: 'Observation API', vendor: 'Papyrus', initials: 'OA', accent: '#ffcf33',
    description: 'Source-neutral authenticated ingestion for normalized evidence, entities, and relationships from customer adapters.',
    integrationClass: 'terrain_source', authority: 'read_only', risk: 'moderate',
    capabilities: ['typed observation ingestion', 'entity provenance', 'relationship provenance'],
    evidenceTypes: [], syncMode: 'push', authSchemes: ['entra', 'certificate', 'mTLS'],
    supportedProfiles: ALL, licenseFeature: 'core',
  },
  {
    id: 'microsoft-teams', name: 'Microsoft Teams', vendor: 'Microsoft', initials: 'MT', accent: '#8f9cff',
    description: 'Government-cloud operator commands, Adaptive Cards, notifications, and portal launches.',
    integrationClass: 'human_interface', authority: 'bidirectional', risk: 'moderate',
    capabilities: ['slash commands', 'adaptive cards', 'portal launch', 'proactive notifications'],
    evidenceTypes: ['HumanContext', 'OperatorRequest'], syncMode: 'hybrid', authSchemes: ['entra', 'certificate'],
    supportedProfiles: ['commercial', 'gcc', 'gcch', 'dod'], licenseFeature: 'teams',
  },
  {
    id: 'exchange-email', name: 'Exchange Email', vendor: 'Microsoft', initials: 'EX', accent: '#75b9ff',
    description: 'Monitored mailbox ingestion and sanitized incident notifications through Microsoft Graph or on-premises Exchange.',
    integrationClass: 'human_interface', authority: 'bidirectional', risk: 'moderate',
    capabilities: ['mailbox polling', 'incident notifications', 'human context'],
    evidenceTypes: ['HumanContext', 'OperatorRequest'], syncMode: 'pull', authSchemes: ['entra', 'certificate', 'managed_identity'],
    supportedProfiles: ALL, licenseFeature: 'email',
  },
  {
    id: 'microsoft-entra', name: 'Microsoft Entra ID', vendor: 'Microsoft', initials: 'ID', accent: '#ffae73',
    description: 'Identity, group, role, application, and privilege terrain from the customer tenant.',
    integrationClass: 'terrain_source', authority: 'read_only', risk: 'high',
    capabilities: ['identity graph', 'group membership', 'application roles', 'privilege relationships'],
    evidenceTypes: ['Identity', 'Privilege', 'TrustRelationship'], syncMode: 'pull', authSchemes: ['entra', 'certificate', 'managed_identity'],
    supportedProfiles: ['commercial', 'gcc', 'gcch', 'dod'], licenseFeature: 'security-connectors',
  },
  {
    id: 'defender-xdr', name: 'Microsoft Defender XDR', vendor: 'Microsoft', initials: 'DX', accent: '#71df98',
    description: 'Endpoint, identity, process, vulnerability, and alert evidence with separately governed response actions.',
    integrationClass: 'evidence_source', authority: 'bidirectional', risk: 'critical',
    capabilities: ['endpoint evidence', 'alert ingestion', 'vulnerability evidence', 'controlled isolation'],
    evidenceTypes: ['Device', 'Alert', 'Process', 'Vulnerability'], syncMode: 'pull', authSchemes: ['entra', 'certificate', 'managed_identity'],
    supportedProfiles: ['commercial', 'gcc', 'gcch', 'dod'], licenseFeature: 'security-connectors',
  },
  {
    id: 'microsoft-sentinel', name: 'Microsoft Sentinel', vendor: 'Microsoft', initials: 'MS', accent: '#d7b7ff',
    description: 'Incidents, analytics results, and normalized security events from an existing Sentinel deployment.',
    integrationClass: 'evidence_source', authority: 'read_only', risk: 'high',
    capabilities: ['incident ingestion', 'analytics evidence', 'security event search'],
    evidenceTypes: ['Incident', 'Alert', 'SecurityEvent'], syncMode: 'pull', authSchemes: ['entra', 'certificate', 'managed_identity'],
    supportedProfiles: ['commercial', 'gcc', 'gcch', 'dod'], licenseFeature: 'security-connectors',
  },
  {
    id: 'zeek', name: 'Zeek', vendor: 'Open source', initials: 'ZK', accent: '#ffd36e',
    description: 'Network connection, protocol, file, certificate, and behavioral observations from local sensors.',
    integrationClass: 'evidence_source', authority: 'read_only', risk: 'low',
    capabilities: ['network metadata', 'protocol observations', 'certificate evidence'],
    evidenceTypes: ['NetworkConnection', 'ProtocolEvent', 'Certificate'], syncMode: 'push', authSchemes: ['mTLS', 'vault_reference', 'none'],
    supportedProfiles: ALL, licenseFeature: 'security-connectors',
  },
  {
    id: 'suricata', name: 'Suricata', vendor: 'Open source', initials: 'SU', accent: '#ff9fb4',
    description: 'IDS alerts, network flows, and protocol events from local EVE JSON streams.',
    integrationClass: 'evidence_source', authority: 'read_only', risk: 'low',
    capabilities: ['IDS alerts', 'network flows', 'protocol evidence'],
    evidenceTypes: ['Alert', 'NetworkFlow', 'ProtocolEvent'], syncMode: 'push', authSchemes: ['mTLS', 'vault_reference', 'none'],
    supportedProfiles: ALL, licenseFeature: 'security-connectors',
  },
  {
    id: 'sysmon', name: 'Windows Sysmon', vendor: 'Microsoft', initials: 'SY', accent: '#92c7ff',
    description: 'Process, network, registry, image-load, and file observations from Windows endpoints.',
    integrationClass: 'evidence_source', authority: 'read_only', risk: 'low',
    capabilities: ['process evidence', 'endpoint network evidence', 'registry observations'],
    evidenceTypes: ['Process', 'NetworkConnection', 'RegistryChange', 'FileEvent'], syncMode: 'push', authSchemes: ['certificate', 'mTLS', 'none'],
    supportedProfiles: ALL, licenseFeature: 'security-connectors',
  },
  {
    id: 'firewall-executor', name: 'Firewall Control', vendor: 'Customer selected', initials: 'FW', accent: '#ff6b4a',
    description: 'Vendor-neutral executor for simulated and explicitly approved route or policy changes.',
    integrationClass: 'action_executor', authority: 'controlled_actions', risk: 'critical',
    capabilities: ['block route', 'quarantine segment', 'revoke temporary rule'],
    evidenceTypes: ['ActionResult', 'NetworkPolicy'], syncMode: 'none', authSchemes: ['certificate', 'mTLS', 'vault_reference'],
    supportedProfiles: ALL, licenseFeature: 'action-executors',
  },
  {
    id: 'a2a-peer', name: 'A2A Agent Peer', vendor: 'Open protocol', initials: 'A2', accent: '#c4f078',
    description: 'Capability-advertised peer agents connected at the Papyrus boundary, never as the Starlings substrate.',
    integrationClass: 'agent_peer', authority: 'bidirectional', risk: 'high',
    capabilities: ['agent card discovery', 'typed handoff', 'peer requests'],
    evidenceTypes: ['PeerClaim', 'PeerRequest'], syncMode: 'push', authSchemes: ['mTLS', 'oauth'],
    supportedProfiles: CONNECTED, licenseFeature: 'agent-peers',
  },
  {
    id: 'acp-client', name: 'ACP Client', vendor: 'Open protocol', initials: 'AC', accent: '#f0b1ff',
    description: 'Programmatic client access for approved cyber-twin investigations and operator capabilities.',
    integrationClass: 'agent_peer', authority: 'bidirectional', risk: 'high',
    capabilities: ['typed investigation request', 'evidence subscription', 'artifact delivery'],
    evidenceTypes: ['PeerRequest', 'PeerClaim'], syncMode: 'push', authSchemes: ['mTLS', 'oauth'],
    supportedProfiles: ALL, licenseFeature: 'agent-peers',
  },
  {
    id: 'customer-vault', name: 'Customer Secret Vault', vendor: 'Customer selected', initials: 'KV', accent: '#ece7d8',
    description: 'Credential references and short-lived secret retrieval without storing connector secrets in Papyrus.',
    integrationClass: 'infrastructure', authority: 'read_only', risk: 'high',
    capabilities: ['credential references', 'secret rotation', 'short-lived credentials'],
    evidenceTypes: [], syncMode: 'none', authSchemes: ['managed_identity', 'certificate', 'mTLS'],
    supportedProfiles: ALL, licenseFeature: 'core',
  },
]

export function catalogEntry(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.id === id)
}
