import { OBSERVATION_API_CONTRACT } from './observation-api.js'
import { MICROSOFT_TEAMS_CONTRACT } from './microsoft-teams.js'
import { EXCHANGE_EMAIL_CONTRACT } from './exchange-email.js'
import { MICROSOFT_ENTRA_CONTRACT } from './microsoft-entra.js'
import { DEFENDER_XDR_CONTRACT } from './defender-xdr.js'
import { MICROSOFT_SENTINEL_CONTRACT } from './microsoft-sentinel.js'
import { ZEEK_CONTRACT } from './zeek.js'
import { SURICATA_CONTRACT } from './suricata.js'
import { SYSMON_CONTRACT } from './sysmon.js'
import { DNS_OBSERVATION_CONTRACT } from './dns-observation.js'
import { ASSET_INVENTORY_CONTRACT } from './asset-inventory.js'
import { FIREWALL_EXECUTOR_CONTRACT } from './firewall-executor.js'
import { A2A_PEER_CONTRACT } from './a2a-peer.js'
import { ACP_CLIENT_CONTRACT } from './acp-client.js'
import { CUSTOMER_VAULT_CONTRACT } from './customer-vault.js'

export * from './types.js'
export * from './observation-api.js'
export * from './microsoft-teams.js'
export * from './exchange-email.js'
export * from './microsoft-entra.js'
export * from './defender-xdr.js'
export * from './microsoft-sentinel.js'
export * from './zeek.js'
export * from './suricata.js'
export * from './sysmon.js'
export * from './dns-observation.js'
export * from './asset-inventory.js'
export * from './firewall-executor.js'
export * from './a2a-peer.js'
export * from './acp-client.js'
export * from './customer-vault.js'

import type { PluginContract } from './types.js'

export const PLUGIN_CONTRACTS = [
  OBSERVATION_API_CONTRACT,
  MICROSOFT_TEAMS_CONTRACT,
  EXCHANGE_EMAIL_CONTRACT,
  MICROSOFT_ENTRA_CONTRACT,
  DEFENDER_XDR_CONTRACT,
  MICROSOFT_SENTINEL_CONTRACT,
  ZEEK_CONTRACT,
  SURICATA_CONTRACT,
  SYSMON_CONTRACT,
  DNS_OBSERVATION_CONTRACT,
  ASSET_INVENTORY_CONTRACT,
  FIREWALL_EXECUTOR_CONTRACT,
  A2A_PEER_CONTRACT,
  ACP_CLIENT_CONTRACT,
  CUSTOMER_VAULT_CONTRACT,
] as const satisfies readonly PluginContract[]

export function pluginContractById(id: string): PluginContract | undefined {
  return PLUGIN_CONTRACTS.find((contract) => contract.id === id)
}
