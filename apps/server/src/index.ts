import { randomBytes } from 'node:crypto'
import { loadConfig, type AgentConfig } from './agent/config.js'
import { AgentDatabase } from './agent/database.js'
import { EntraAuthService } from './agent/entra-auth.js'
import { createAgentServer } from './agent/http.js'
import { installEnhancedAgentPlane } from './agent/enhanced-http.js'
import { createBootstrapServer } from './agent/bootstrap-http.js'
import { AgentService } from './agent/service.js'
import { LicenseService } from './license.js'
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
import { EnhancedMastraRuntime } from './agent/mastra/enhanced-runtime.js'
import { ApplianceConsoleExecutor } from './agent/executors/appliance-console-executor.js'
import { FirewallExecutor, UnconfiguredConnectorCredentialResolver } from './agent/executors/firewall-executor.js'
import { UnconfiguredDeviceCredentialResolver } from './agent/browser/credential.js'
import { APPLIANCE_CONSOLE_CATALOG_ID, FIREWALL_CATALOG_ID } from './agent/catalog.js'
import { getRenderSource } from './agent/browser/render.js'
import { resolveBrowserExecutable } from './agent/browser/executable.js'

const loaded = loadConfig()

if (loaded.phase === 'bootstrap') {
  const context = loaded.context
  // Bootstrap needs only the database and the license service: the deployment
  // identity is generated here so the onboarding screen can show the deployment id
  // the operator must submit to obtain a signed license.
  const database = new AgentDatabase(context.databasePath)
  const licenseService = new LicenseService(
    database, context.dataDir, context.profile, context.licenseAuthorities, context.licenseRequired,
  )

  const setupToken = randomBytes(24).toString('base64url')
  const bootstrapServer = createBootstrapServer(context, licenseService, () => {
    const reloaded = loadConfig()
    if (reloaded.phase !== 'ready') {
      console.error('Onboarding completed but the configuration is still incomplete')
      process.exit(1)
    }
    database.close()
    bootstrapServer.close(() => {
      startFull(reloaded.config).catch((cause) => { console.error('Failed to start the daemon after onboarding:', cause); process.exit(1) })
    })
  }, setupToken)

  bootstrapServer.listen(context.port, context.host, () => {
    console.log(`Papyrus onboarding listening at http://${context.host}:${context.port}`)
    console.log(`Deployment ID: ${licenseService.deploymentId}`)
    console.log(`Setup token: ${setupToken}`)
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { database.close(); bootstrapServer.closeAllConnections(); process.exit(0) })
  }
} else {
  startFull(loaded.config).catch((cause) => { console.error('Failed to start the daemon:', cause); process.exit(1) })
}

async function startFull(config: AgentConfig): Promise<void> {
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
  const mastraRuntime = new EnhancedMastraRuntime(config, actionStore, terrain, service)
  await mastraRuntime.start()
  const server = createAgentServer(config, service, auth, mastraRuntime)
  installEnhancedAgentPlane(server, service, auth, mastraRuntime)

  // Exchange shares one Graph client boundary for inbound mailbox delta sync and
  // approved outbound mail. The default client deliberately refuses to resolve
  // credentials until the customer supplies its vault/workload-identity adapter.
  connectors.register('exchange-email', new ExchangeEmailDriver(graph))
  executorRegistry.register('exchange-email', new EmailExecutor(database, graph, mastraRuntime.artifacts))
  executorRegistry.register(LINK_PUBLISHER_CATALOG_ID, new LinkPublisherExecutor(mastraRuntime.links, new KitesurfLinkValidator(config)))
  const deviceCredentials = new UnconfiguredDeviceCredentialResolver()
  executorRegistry.register(APPLIANCE_CONSOLE_CATALOG_ID, new ApplianceConsoleExecutor(database, mastraRuntime.consoles, deviceCredentials, (integration, policy) => getRenderSource({
    integrationId: integration.id,
    integrationName: integration.name,
    executable: () => resolveBrowserExecutable(integration, config),
    assertAllowedUrl: (url) => { policy.assertAllowed(url) },
  })))
  executorRegistry.register(FIREWALL_CATALOG_ID, new FirewallExecutor(database, new UnconfiguredConnectorCredentialResolver()))

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
}
