import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ACP_PROTOCOL_VERSION } from '../../acp-runtime/dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(dirname(here))
const expectedExports = ['ACP_PROTOCOL_VERSION','AgentRuntime','RuntimeCapabilities','RuntimeEvent','RuntimeEventKind','RuntimeHealth','RuntimeLaunchOptions','RuntimePromptRequest','RuntimePromptResult','RuntimeTool','RuntimeTransport'].sort()
test('ACP runtime contract surface stays explicit', () => {
  const source = readFileSync(join(repoRoot, 'acp-runtime/src/index.ts'), 'utf8')
  const names = new Set()
  const pattern = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(pattern)) names.add(match[1])
  assert.deepEqual([...names].sort(), expectedExports)
  assert.ok(ACP_PROTOCOL_VERSION)
})
