import { loadCyberConfig } from './cyber/config.js'
import { CyberDatabase } from './cyber/database.js'
import { EntraAuthService } from './cyber/entra-auth.js'
import { createCyberServer } from './cyber/http.js'
import { CyberService } from './cyber/service.js'
import { ActionExecutorRegistry, ActionWorker } from './cyber/action-worker.js'
import { ActionStore } from './cyber/action-store.js'
import { ConnectorRegistry, SyncWorker } from './cyber/sync-worker.js'
import { TerrainStore } from './cyber/terrain-store.js'
import { EmailExecutor } from './cyber/executors/email-executor.js'
import { ExchangeEmailDriver } from './cyber/drivers/exchange-email-driver.js'
import { HttpMicrosoftGraphClient } from './cyber/graph-client.js'
import { MastraRuntime } from './cyber/mastra/runtime.js'

const config = loadCyberConfig()
const database = new CyberDatabase(config.databasePath)
const auth = new EntraAuthService(config)
const terrain = new TerrainStore(database)
const connectors = new ConnectorRegistry()
const graph = new HttpMicrosoftGraphClient(config)
const actionStore = new ActionStore(database)
const executorRegistry = new ActionExecutorRegistry()
const worker = new SyncWorker(database, terrain, connectors)
const actionWorker = new ActionWorker(database, actionStore, executorRegistry, config)
const service = new CyberService(database, config, terrain, worker, actionStore, executorRegistry, actionWorker)
const server = createCyberServer(config, service, auth)

// Exchange shares one Graph client boundary for inbound mailbox delta sync and
// approved outbound mail. The default client deliberately refuses to resolve
// credentials until the customer supplies its vault/workload-identity adapter.
connectors.register('exchange-email', new ExchangeEmailDriver(graph))
executorRegistry.register('exchange-email', new EmailExecutor(database, graph))

// Initialize Mastra runtime (local development mode)
const mastraRuntime = new MastraRuntime(config, actionStore, terrain, service)
mastraRuntime.start().catch((cause) => console.error('[mastra] failed to start', cause))

server.listen(config.port, config.host, () => {
  worker.start()
  actionWorker.start()
  console.log(`Papyrus Cyber Twin listening at ${config.publicOrigin}`)
  console.log(`Profile: ${config.profile}; Entra cloud: ${config.cloud}; deployment: ${service.license.deploymentId}`)
  console.log(`Investigation runtime: ${mastraRuntime.mode}`)
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
  await actionWorker.stop()
  await mastraRuntime.stop()
  await closeServer(server)
  database.close()
  process.exit(0)
}

function closeServer(target: typeof server): Promise<void> {
  return new Promise((resolve) => target.close(() => resolve()))
}
