import { definePluginContract, ALL_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const ZEEK_CONTRACT = definePluginContract({
  id: "zeek",
  name: "Zeek",
  vendor: "Open source",
  description: "Network connection, protocol, file, certificate, and behavioral observations from local sensors.",
  integrationClass: "evidence_source",
  authority: "read_only",
  risk: "low",
  capabilities: ["network metadata","protocol observations","certificate evidence"],
  evidenceTypes: ["NetworkConnection","ProtocolEvent","Certificate"],
  syncMode: "push",
  authSchemes: ["mTLS","vault_reference","none"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "zeek.conn@1", evidenceType: "NetworkConnection", fixture: "tests/fixtures/zeek.json" },
  ],
  replayFixtures: ["tests/fixtures/zeek.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
