import { definePluginContract, ALL_PROFILES, READ_ONLY_PULL_SECURITY } from './types.js'

export const CUSTOMER_VAULT_CONTRACT = definePluginContract({
  id: "customer-vault",
  name: "Customer Secret Vault",
  vendor: "Customer selected",
  description: "Credential references and short-lived secret retrieval without storing connector secrets in Papyrus.",
  integrationClass: "infrastructure",
  authority: "read_only",
  risk: "high",
  capabilities: ["credential references","secret rotation","short-lived credentials"],
  evidenceTypes: [],
  syncMode: "none",
  authSchemes: ["managed_identity","certificate","mTLS"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "core",
  security: READ_ONLY_PULL_SECURITY,
  conformance: {"replay":"optional","integration":"required","live":"optional"},
})
