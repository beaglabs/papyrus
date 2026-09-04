import { definePluginContract, MICROSOFT_CLOUD_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const MICROSOFT_ENTRA_CONTRACT = definePluginContract({
  id: "microsoft-entra",
  name: "Microsoft Entra ID",
  vendor: "Microsoft",
  description: "Customer-pushed identity, group, role, application, and privilege terrain exported from Microsoft Entra.",
  integrationClass: "terrain_source",
  authority: "read_only",
  risk: "high",
  capabilities: ["identity graph","group membership","customer-managed export"],
  evidenceTypes: ["Identity","Privilege","TrustRelationship"],
  syncMode: "push",
  authSchemes: ["entra","certificate","mTLS"],
  supportedProfiles: MICROSOFT_CLOUD_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "entra.user@1", evidenceType: "Identity", fixture: "tests/fixtures/microsoft-entra.json" },
    { id: "entra.group-membership@1", evidenceType: "TrustRelationship", fixture: "tests/fixtures/microsoft-entra.json" },
  ],
  replayFixtures: ["tests/fixtures/microsoft-entra.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
