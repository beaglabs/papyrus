import { definePluginContract, ALL_PROFILES, CONTROLLED_ACTION_SECURITY } from './types.js'

export const FIREWALL_EXECUTOR_CONTRACT = definePluginContract({
  id: "firewall-executor",
  name: "Firewall Control",
  vendor: "Customer selected",
  description: "Vendor-neutral executor for simulated and explicitly approved route or policy changes.",
  integrationClass: "action_executor",
  authority: "controlled_actions",
  risk: "critical",
  capabilities: ["block route","quarantine segment","revoke temporary rule"],
  evidenceTypes: ["ActionResult","NetworkPolicy"],
  syncMode: "none",
  authSchemes: ["certificate","mTLS","vault_reference"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "action-executors",
  requiredSettings: ["endpoint"],
  security: CONTROLLED_ACTION_SECURITY,
  conformance: {"replay":"optional","integration":"required","live":"optional"},
})
