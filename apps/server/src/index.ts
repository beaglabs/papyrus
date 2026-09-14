import { loadAgentConfig } from './agent/config.js'
import { AgentDatabase } from './agent/database.js'
import { EntraAuthService } from './agent/entra-auth.js'
import { createAgentServer } from './agent/http.js'
import { AgentService } from './agent/service.js'
import { ActionExecutorRegistry, ActionWorker } from './agent/action-worker.js'
import { ActionStore } from './agent/action-store.js'
import { ConnectorRegistry, SyncWorker } from './agent/sync-worker.js'
import { TerrainStore } from './agent/terrain-store.js'
import { EmailExecutor } from './agent/executors/email-executor.js'
import { LinkPublisherExecutor } from './agent/executors/link-publisher-executor.js'
import { KitesurfLinkValidator } from './agent/link-preview.js'
import { LINK_PUBLISHER_CATALOG_ID } from './agent/catalog.js'
import { ExchangeEmailDriver } from './agent/drivers/exchange-email-driver.js'
import { HttpMicrosoftGraphClient } from './agent/graph-client.js'
import { MastraRuntime } from './agent/mastra/runtime.js'
import { ApplianceConsoleExecutor } from './agent/executors/appliance-console-executor.js'
import { UnconfiguredDeviceCredentialResolver } from './agent/browser/credential.js'
import { APPLIANCE_CONSOLE_CATALOG_ID } from './agent/catalog.js'
import { getRenderSource } from './agent/browser/render.js'
import { resolveBrowserExecutable } from './agent/browser/executable.js'

const config = loadAgentConfig()
const database = new AgentDatabase(config.databasePath)
const auth = new EntraAuthService(config)
const terrain = new TerrainStore(database)
const connectors = new ConnectorRegistry()
const graph = new HttpMicrosoftGraphClient(config)
const actionStore = new ActionStore(database)
const executorRegistry = new ActionExecutorRegistry()
const worker = new SyncWorker(database, terrain, connectors)
const actionWorker = new ActionWorker(database, actionStore, executorRegistry, config)
const service = new AgentService(database, config, terrain, worker, actionStore, executorRegistry, actionWorker)
const mastraRuntime = new MastraRuntime(config, actionStore, terrain, service)
await mastraRuntime.start()
const server = createAgentServer(config, service, auth, mastraRuntime)

// Exchange shares one Graph client boundary for inbound mailbox delta sync and
// approved outbound mail. The default client deliberately refuses to resolve
// credentials until the customer supplies its vault/workload-identity adapter.
connectors.register('exchange-email', new ExchangeEmailDriver(graph))
executorRegistry.register('exchange-email', new EmailExecutor(database, graph, mastraRuntime.artifacts))
executorRegistry.register(LINK_PUBLISHER_CATALOG_ID, new LinkPublisherExecutor(mastraRuntime.links, new KitesurfLinkValidator(config))
)
// The appliance console is an action executor, not a data connector: it produces
// evidence as page snapshots inside the runtime and only ever changes a device
// through a proposal an operator released. Like Graph, its credential boundary
// defaults to a resolver that refuses until the customer wires its own vault, so a
// console can be read and described immediately but cannot log in unconfigured.
const deviceCredentials = new UnconfiguredDeviceCredentialResolver()
// A browser is operator-supplied and optional: with nothing configured the rendered
// path refuses and the executor will not release a rendered submission, so the
// daemon never reaches for a browser it was not given.
executorRegistry.register(APPLIANCE_CONSOLE_CATALOG_ID, new ApplianceConsoleExecutor(database, mastraRuntime.consoles, deviceCredentials, (integration, policy) => getRenderSource({
  integrationId: integration.id,
  integrationName: integration.name,
  executable: () => resolveBrowserExecutable(integration, config),
  assertAllowedUrl: (url) => { policy.assertAllowed(url) },
})))

server.listen(config.port, config.host, () => {
  worker.start()
  actionWorker.start()
  console.log(`Papyrus daemon listening at ${config.publicOrigin}`)
  console.log(`Profile: ${config.profile}; Entra cloud: ${config.cloud}; deployment: ${service.license.deploymentId}`)
  console.log(`Agent runtime: ${mastraRuntime.status.runtime}`)
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
