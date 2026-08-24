import { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { AuthService } from './auth.js'
import { loadConfig } from './config.js'
import { PapyrusDatabase } from './db.js'
import { createGatewayServer } from './gateway.js'
import { createPapyrusServer } from './http.js'
import { createPapyrusMastra } from './mastra/server.js'
import { PapyrusService } from './service.js'

const config = loadConfig()
const database = new PapyrusDatabase(config.databasePath)
const auth = new AuthService(config, database)
const { mastra, hono: mastraApp } = createPapyrusMastra(config, database, auth)
const service = new PapyrusService(database, config, mastra)
const server = createPapyrusServer(config, service, auth)
server.on('request', (req, res) => {
  if (!req.url?.startsWith('/api/agents/')) return
  const honoReq = toHonoRequest(req)
  Promise.resolve(mastraApp.fetch(honoReq)).then((response) => forwardResponse(res, response))
})
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

function toHonoRequest(req: IncomingMessage): Request {
  const url = req.url ?? '/'
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'
  const host = req.headers.host ?? 'localhost'
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    else if (typeof value === 'string') headers.set(key, value)
  }
  return new Request(`${protocol}://${host}${url}`, { method: req.method ?? 'GET', headers })
}

function forwardResponse(res: ServerResponse, response: Response): Promise<void> | void {
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.statusCode = response.status
  if (!response.body) { res.end(); return }
  const node = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
  node.pipe(res)
  return
}
