import { loadCyberConfig } from './cyber/config.js'
import { CyberDatabase } from './cyber/database.js'
import { EntraAuthService } from './cyber/entra-auth.js'
import { createCyberServer } from './cyber/http.js'
import { CyberService } from './cyber/service.js'
import { ConnectorRegistry, SyncWorker } from './cyber/sync-worker.js'
import { TerrainStore } from './cyber/terrain-store.js'

const config = loadCyberConfig()
const database = new CyberDatabase(config.databasePath)
const auth = new EntraAuthService(config)
const terrain = new TerrainStore(database)
const connectors = new ConnectorRegistry()
const worker = new SyncWorker(database, terrain, connectors)
const service = new CyberService(database, config, terrain, worker)
const server = createCyberServer(config, service, auth)

server.listen(config.port, config.host, () => {
  worker.start()
  console.log(`Papyrus Cyber Twin listening at ${config.publicOrigin}`)
  console.log(`Profile: ${config.profile}; Entra cloud: ${config.cloud}; deployment: ${service.license.deploymentId}`)
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown() })
}

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  server.closeAllConnections()
  await worker.stop()
  await closeServer(server)
  database.close()
  process.exit(0)
}

function closeServer(target: typeof server): Promise<void> {
  return new Promise((resolve) => target.close(() => resolve()))
}
