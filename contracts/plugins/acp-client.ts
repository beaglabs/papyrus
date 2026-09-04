import { definePluginContract, ALL_PROFILES, BIDIRECTIONAL_SECURITY } from './types.js'

export const ACP_CLIENT_CONTRACT = definePluginContract({
  id: "acp-client",
  name: "ACP Client",
  vendor: "Open protocol",
  description: "Programmatic client access for approved agent-twin investigations and operator capabilities.",
  integrationClass: "agent_peer",
  authority: "bidirectional",
  risk: "high",
  capabilities: ["typed investigation request","evidence subscription","artifact delivery"],
  evidenceTypes: ["PeerRequest","PeerClaim"],
  syncMode: "push",
  authSchemes: ["mTLS","oauth"],
  supportedProfiles: ALL_PROFILES,
  licenseFeature: "agent-peers",
  requiredSettings: ["endpoint"],
  security: BIDIRECTIONAL_SECURITY,
  conformance: {"replay":"optional","integration":"required","live":"optional"},
})
