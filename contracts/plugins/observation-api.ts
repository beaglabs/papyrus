import { definePluginContract, ALL_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const OBSERVATION_API_CONTRACT = definePluginContract({
  id: "observation-api",
  name: "Custom Source",
  vendor: "Observation API",
  description: "Source-neutral push ingestion for customer-defined evidence and canonical Terrain projections.",
  integrationClass: "terrain_source",
  authority: "read_only",
  risk: "moderate",
  capabilities: ["custom JSON evidence","canonical Terrain projection","source provenance"],
  evidenceTypes: [],
  syncMode: "push",
  authSchemes: ["entra","certificate","mTLS"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "core",
  replayFixtures: ["tests/fixtures/observation-api.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"not_applicable"},
})
