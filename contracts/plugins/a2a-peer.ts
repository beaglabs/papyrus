import { definePluginContract, CONNECTED_PROFILES, BIDIRECTIONAL_SECURITY } from './types.js'

export const A2A_PEER_CONTRACT = definePluginContract({
  id: "a2a-peer",
  name: "A2A Agent Peer",
  vendor: "Open protocol",
  description: "Capability-advertised peer agents connected at the Papyrus boundary, never as the Starlings substrate.",
  integrationClass: "agent_peer",
  authority: "bidirectional",
  risk: "high",
  capabilities: ["agent card discovery","typed handoff","peer requests"],
  evidenceTypes: ["PeerClaim","PeerRequest"],
  syncMode: "push",
  authSchemes: ["mTLS","oauth"],
  supportedProfiles: CONNECTED_PROFILES,
  licenseFeature: "agent-peers",
  requiredSettings: ["endpoint"],
  security: BIDIRECTIONAL_SECURITY,
  conformance: {"replay":"optional","integration":"required","live":"optional"},
})
