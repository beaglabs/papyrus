import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node'
import { RUNTIME_CONFIG_HEADER } from '@papyrus/goose-runtime'
import { GooseBridge } from './bridge.js'
import type { WorkerConfig } from './config.js'

interface ConnectionContext {
  env: Record<string, string>
}

function decodeRuntimeConfig(value: string | undefined): Record<string, string> {
  if (!value) return {}
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Runtime config must be a JSON object')
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(decoded as Record<string, unknown>)) {
    if (typeof entry !== 'string') throw new Error(`Runtime config entry "${key}" is not a string`)
    env[key] = entry
  }
  return env
}

function isAuthorized(config: WorkerConfig, req: IncomingMessage): boolean {
  // Mutual TLS is enforced at the TLS layer (rejectUnauthorized + requestCert).
  // Double-check the peer flag when the socket is a TLS socket.
  const socket = req.socket as TLSSocket
  if (typeof socket.authorized === 'boolean' && !socket.authorized) return false
  if (config.allowFingerprints) {
    const certificate = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined
    const fingerprint = certificate?.fingerprint256?.replace(/:/g, '').toLowerCase()
    if (!fingerprint || !config.allowFingerprints.includes(fingerprint)) return false
  }
  if (!config.token) return true
  const presented = req.headers.authorization
  if (!presented) return false
  const expected = `Bearer ${config.token}`
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function createWorkerServer(config: WorkerConfig) {
  const als = new AsyncLocalStorage<ConnectionContext>()

  const acpServer = new AcpServer({
    createAgent: () => {
      const context = als.getStore()
      return new GooseBridge({
        command: config.command,
        args: config.args,
        env: context?.env ?? {},
        onStderr: (chunk) => process.stderr.write(`[goose] ${chunk}\n`),
      })
    },
  })

  const handle = createNodeHttpHandler(acpServer)

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ status: 'ok', command: config.command }))
      return
    }
    if (!isAuthorized(config, req)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('Unauthorized')
      return
    }
    let env: Record<string, string>
    try {
      env = decodeRuntimeConfig(req.headers[RUNTIME_CONFIG_HEADER] as string | undefined)
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('Invalid runtime config')
      return
    }
    als.run({ env }, () => handle(req, res))
  }

  if (config.tls) {
    return createHttpsServer({
      cert: readFileSync(config.tls.certPath),
      key: readFileSync(config.tls.keyPath),
      ca: readFileSync(config.tls.caPath),
      requestCert: true,
      rejectUnauthorized: true,
    }, handler)
  }
  if (config.host !== '127.0.0.1' && config.host !== '::1') {
    throw new Error('Worker requires mutual TLS when listening on a non-loopback address')
  }
  return createHttpServer(handler)
}
