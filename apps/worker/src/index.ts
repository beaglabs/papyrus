import { loadConfig } from './config.js'
import { createWorkerServer } from './server.js'

const config = loadConfig()
const server = createWorkerServer(config)

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http'
  const auth = config.tls ? ' (mTLS)' : ''
  console.log(`Papyrus goose worker listening on ${scheme}://${config.host}:${config.port}${auth}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  })
}
