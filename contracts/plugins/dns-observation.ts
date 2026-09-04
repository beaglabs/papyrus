import { definePluginContract, ALL_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const DNS_OBSERVATION_CONTRACT = definePluginContract({
  id: "dns-observation",
  name: "DNS Resolver",
  vendor: "Customer selected",
  description: "Customer-pushed DNS queries and responses from an approved resolver or log pipeline.",
  integrationClass: "evidence_source",
  authority: "read_only",
  risk: "low",
  capabilities: ["resolution evidence","domain infrastructure","resolver-independent schema"],
  evidenceTypes: ["DNSResolution"],
  syncMode: "push",
  authSchemes: ["certificate","mTLS","none"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "dns.response@1", evidenceType: "DNSResolution", fixture: "tests/fixtures/dns-observation.json" },
  ],
  replayFixtures: ["tests/fixtures/dns-observation.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
