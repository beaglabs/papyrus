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
    console.log(`Papyrus ACP gateway listening on ${config.gateway!.host}:${config.gateway!.port}`)
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => { database.close(); process.exit(0) })
    gateway?.close(() => process.exit(0))
  })
}
