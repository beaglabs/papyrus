import { definePluginContract, ALL_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const SYSMON_CONTRACT = definePluginContract({
  id: "sysmon",
  name: "Windows Sysmon",
  vendor: "Microsoft",
  description: "Process, network, registry, image-load, and file observations from Windows endpoints.",
  integrationClass: "evidence_source",
  authority: "read_only",
  risk: "low",
  capabilities: ["process evidence","endpoint network evidence","registry observations"],
  evidenceTypes: ["Process","NetworkConnection","RegistryChange","FileEvent"],
  syncMode: "push",
  authSchemes: ["certificate","mTLS","none"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "sysmon.network-connect@1", evidenceType: "NetworkConnection", fixture: "tests/fixtures/sysmon.json" },
    { id: "sysmon.process-create@1", evidenceType: "Process", fixture: "tests/fixtures/sysmon.json" },
  ],
  replayFixtures: ["tests/fixtures/sysmon.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
