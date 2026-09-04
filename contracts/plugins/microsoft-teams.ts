import { definePluginContract, MICROSOFT_CLOUD_PROFILES, BIDIRECTIONAL_SECURITY } from './types.js'

export const MICROSOFT_TEAMS_CONTRACT = definePluginContract({
  id: "microsoft-teams",
  name: "Microsoft Teams",
  vendor: "Microsoft",
  description: "Government-cloud operator commands, Adaptive Cards, notifications, and portal launches.",
  integrationClass: "human_interface",
  authority: "bidirectional",
  risk: "moderate",
  capabilities: ["slash commands","adaptive cards","portal launch","proactive notifications"],
  evidenceTypes: ["HumanContext","OperatorRequest"],
  syncMode: "hybrid",
  authSchemes: ["entra","certificate"],
  supportedProfiles: MICROSOFT_CLOUD_PROFILES,
  licenseFeature: "teams",
  security: BIDIRECTIONAL_SECURITY,
  conformance: {"replay":"optional","integration":"required","live":"required"},
})
