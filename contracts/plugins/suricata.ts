import { definePluginContract, ALL_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const SURICATA_CONTRACT = definePluginContract({
  id: "suricata",
  name: "Suricata",
  vendor: "Open source",
  description: "IDS alerts, network flows, and protocol events from local EVE JSON streams.",
  integrationClass: "evidence_source",
  authority: "read_only",
  risk: "low",
  capabilities: ["IDS alerts","network flows","protocol evidence"],
  evidenceTypes: ["Alert","NetworkFlow","ProtocolEvent"],
  syncMode: "push",
  authSchemes: ["mTLS","vault_reference","none"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "suricata.eve.alert@1", evidenceType: "Alert", fixture: "tests/fixtures/suricata.json" },
    { id: "suricata.eve.flow@1", evidenceType: "NetworkFlow", fixture: "tests/fixtures/suricata.json" },
  ],
  replayFixtures: ["tests/fixtures/suricata.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
