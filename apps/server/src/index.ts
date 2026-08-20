import { AuthService } from './auth.js'
import { loadConfig } from './config.js'
import { PapyrusDatabase } from './db.js'
import { createGatewayServer } from './gateway.js'
import { createPapyrusServer } from './http.js'
import { PapyrusService } from './service.js'

const config = loadConfig()
const database = new PapyrusDatabase(config.databasePath)
const service = new PapyrusService(database, config)
const auth = new AuthService(config, database)
const server = createPapyrusServer(config, service, auth)
const gateway = config.gateway ? createGatewayServer(config, service, auth) : undefined

server.listen(config.port, config.host, () => {
  console.log(`Papyrus ${config.mode} server listening at ${config.publicOrigin}`)
  console.log(`Profile: ${config.profile}; deployment: ${service.license.deploymentId}`)
})

if (gateway && config.gateway) {
  gateway.listen(config.gateway.port, config.gateway.host, () => {
    const protocol = config.gateway!.tls ? 'https' : 'http'
    const host = config.gateway!.host.includes(':') && !config.gateway!.host.startsWith('[') ? `[${config.gateway!.host}]` : config.gateway!.host
    console.log(`Papyrus ACP Streamable HTTP listening at ${protocol}://${host}:${config.gateway!.port}/acp`)
  })
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown() })
}

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  await service.shutdown()
  server.closeAllConnections()
  gateway?.closeAllConnections()
  await Promise.all([closeServer(server), ...(gateway ? [closeServer(gateway)] : [])])
  database.close()
  process.exit(0)
}

function closeServer(target: typeof server): Promise<void> {
  return new Promise((resolve) => target.close(() => resolve()))
}
