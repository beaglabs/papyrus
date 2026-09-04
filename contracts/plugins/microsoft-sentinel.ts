import { definePluginContract, MICROSOFT_CLOUD_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const MICROSOFT_SENTINEL_CONTRACT = definePluginContract({
  id: "microsoft-sentinel",
  name: "Microsoft Sentinel",
  vendor: "Microsoft",
  description: "Customer-pushed incidents, analytics results, and normalized events exported from Sentinel.",
  integrationClass: "evidence_source",
  authority: "read_only",
  risk: "high",
  capabilities: ["incident ingestion","analytics evidence","customer-managed export"],
  evidenceTypes: ["Incident","Alert","SecurityEvent"],
  syncMode: "push",
  authSchemes: ["entra","certificate","mTLS"],
  supportedProfiles: MICROSOFT_CLOUD_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "sentinel.incident@1", evidenceType: "Incident", fixture: "tests/fixtures/microsoft-sentinel.json" },
  ],
  replayFixtures: ["tests/fixtures/microsoft-sentinel.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
