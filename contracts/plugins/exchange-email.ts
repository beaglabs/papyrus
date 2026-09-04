import { definePluginContract, ALL_PROFILES, BIDIRECTIONAL_SECURITY } from './types.js'

export const EXCHANGE_EMAIL_CONTRACT = definePluginContract({
  id: "exchange-email",
  name: "Exchange Email",
  vendor: "Microsoft",
  description: "Monitored mailbox ingestion and sanitized incident notifications through Microsoft Graph or on-premises Exchange.",
  integrationClass: "human_interface",
  authority: "bidirectional",
  risk: "moderate",
  capabilities: ["mailbox polling","incident notifications","human context"],
  evidenceTypes: ["HumanContext","OperatorRequest"],
  syncMode: "pull",
  authSchemes: ["entra","certificate","managed_identity"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "email",
  requiredSettings: ["mailbox"],
  replayFixtures: ["tests/fixtures/exchange-email.json"],
  security: BIDIRECTIONAL_SECURITY,
  conformance: {"replay":"required","integration":"required","live":"required"},
})
