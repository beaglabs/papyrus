import { Readable, Writable } from 'node:stream'
import type { Stream } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { bridgeAcp } from '../src/bridge.js'
import { resolveConnectOptions } from '../src/options.js'

describe('papyrus-connect', () => {
  it('preserves ACP frames in both directions', async () => {
    const received: unknown[] = []
    let remote!: ReadableStreamDefaultController<unknown>
    const stream: Stream = {
      readable: new ReadableStream({ start: (controller) => { remote = controller } }),
      writable: new WritableStream({
        write: (message) => {
          received.push(message)
          remote.enqueue({ jsonrpc: '2.0', id: 1, result: { ok: true } })
        },
        close: () => remote.close(),
      }),
    } as Stream
    let output = ''
    const sink = new Writable({ write: (chunk, _encoding, done) => { output += chunk.toString(); done() } })

    await bridgeAcp(stream, Readable.from(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n']), sink)

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }])
    expect(output.trim()).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')
  })

  it('uses only the single ACP endpoint and Papyrus-specific credentials', () => {
    expect(resolveConnectOptions([], {
      PAPYRUS_CONNECT_URL: 'https://papyrus.example.test',
      PAPYRUS_CONNECT_TOKEN: 'session-token',
      PAPYRUS_CONNECT_WORKSPACE: 'workspace-1',
    })).toEqual({
      url: 'https://papyrus.example.test/acp',
      headers: {
        authorization: 'Bearer session-token',
        'x-papyrus-workspace-id': 'workspace-1',
      },
    })
    expect(() => resolveConnectOptions([], {
      PAPYRUS_CONNECT_URL: 'https://papyrus.example.test/acp/goose',
    })).toThrow(/single \/acp endpoint/)
  })

  it('rejects malformed stdio frames', async () => {
    const stream: Stream = {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    } as Stream
    await expect(bridgeAcp(stream, Readable.from(['not-json\n']), new Writable({ write: (_chunk, _encoding, done) => done() })))
      .rejects.toThrow(/invalid JSON/)
  })
})
