import { spawn } from 'node:child_process'
import { defineCommand } from 'citty'
import { banner } from './_shared.js'

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', url]]
        : ['xdg-open', [url]]
  const child = spawn(command[0] as string, command[1] as string[], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

export default defineCommand({
  meta: {
    name: 'papyrus serve',
    description: 'Run the authoritative Papyrus server, API, and web application.',
  },
  args: {
    host: {
      type: 'string',
      description: 'Interface to bind.',
      default: '127.0.0.1',
    },
    port: {
      type: 'string',
      description: 'HTTP(S) port.',
      default: '3777',
    },
    open: {
      type: 'boolean',
      description: 'Open Papyrus in the default browser.',
      default: true,
    },
  },
  async run({ args }) {
    const host = String(args.host)
    const port = String(args.port)
    process.env.PAPYRUS_HOST = host
    process.env.PAPYRUS_PORT = port

    banner('serve')
    const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
    const protocol = process.env.PAPYRUS_TLS_CERT && process.env.PAPYRUS_TLS_KEY ? 'https' : 'http'
    if (args.open !== false) {
      setTimeout(() => openBrowser(`${protocol}://${browserHost}:${port}`), 400)
    }

    await import('@papyrus/daemon')
  },
})
