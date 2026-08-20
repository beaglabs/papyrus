#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client'
import { bridgeAcp } from './bridge.js'
import { resolveConnectOptions } from './options.js'

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write('Usage: papyrus-connect [--url https://host/acp] [--workspace ID]\n')
    process.stderr.write('Authentication: PAPYRUS_CONNECT_TOKEN or PAPYRUS_CONNECT_TOKEN_FILE\n')
    return
  }
  const options = resolveConnectOptions(argv, env)
  const stream = createHttpStream(options.url, { headers: options.headers })
  const controller = new AbortController()
  const stop = (): void => controller.abort(new Error('papyrus-connect stopped'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await bridgeAcp(stream, process.stdin, process.stdout, controller.signal)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`papyrus-connect: ${error instanceof Error ? error.message : 'connection failed'}\n`)
    process.exitCode = 1
  })
}
