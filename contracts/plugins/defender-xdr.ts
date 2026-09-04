import { definePluginContract, MICROSOFT_CLOUD_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const DEFENDER_XDR_CONTRACT = definePluginContract({
  id: "defender-xdr",
  name: "Microsoft Defender XDR",
  vendor: "Microsoft",
  description: "Customer-pushed endpoint, identity, process, vulnerability, and alert evidence exported from Defender XDR.",
  integrationClass: "evidence_source",
  authority: "read_only",
  risk: "high",
  capabilities: ["endpoint evidence","alert ingestion","customer-managed export"],
  evidenceTypes: ["Device","Alert","Process","Vulnerability"],
  syncMode: "push",
  authSchemes: ["entra","certificate","mTLS"],
  supportedProfiles: MICROSOFT_CLOUD_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "defender.alert@1", evidenceType: "Alert", fixture: "tests/fixtures/defender-xdr.json" },
  ],
  replayFixtures: ["tests/fixtures/defender-xdr.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
