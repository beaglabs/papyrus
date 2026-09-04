import { definePluginContract, ALL_PROFILES, READ_ONLY_PUSH_SECURITY } from './types.js'

export const ASSET_INVENTORY_CONTRACT = definePluginContract({
  id: "asset-inventory",
  name: "Asset Inventory",
  vendor: "Customer selected",
  description: "Customer-pushed device and address inventory from a CMDB, scheduled export, or approved system of record.",
  integrationClass: "terrain_source",
  authority: "read_only",
  risk: "low",
  capabilities: ["device inventory","network addresses","canonical Terrain projection"],
  evidenceTypes: ["AssetInventory"],
  syncMode: "push",
  authSchemes: ["certificate","mTLS","none"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "security-connectors",
  observationSchemas: [
    { id: "asset.device@1", evidenceType: "AssetInventory", fixture: "tests/fixtures/asset-inventory.json" },
  ],
  replayFixtures: ["tests/fixtures/asset-inventory.json"],
  security: READ_ONLY_PUSH_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"optional"},
})
