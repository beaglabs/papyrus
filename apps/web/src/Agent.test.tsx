import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Composer, ReasoningActivity, ToolActivity, isNearScrollBottom } from './Agent.js'

describe('Agent composer', () => {
  it('keeps upload, Library, attachment affordances, and send visible in the base render', () => {
    const html = renderToStaticMarkup(<Composer
      input=""
      setInput={() => undefined}
      attachments={[]}
      setAttachments={() => undefined}
      disabled={false}
      working={false}
      onStop={() => undefined}
      onSubmit={() => undefined}
      workspace={{
        filesystem: 'agentfs-sdk',
        storage: 'local-sqlite',
        programmableRuntime: 'enclave-strict',
        processSandbox: 'nono-ts',
        isolation: 'seatbelt',
        network: 'blocked',
        rawShell: false,
      }}
    />)

    expect(html).toContain('placeholder="Ask Papyrus… Type @ to attach from Library."')
    expect(html).toContain('>Upload</span>')
    expect(html).toContain('>Library</span>')
    expect(html).toContain('type="file"')
    expect(html).toContain('multiple=""')
    expect(html).toContain('aria-label="Send message"')
    expect(html).toContain('AgentFS · Enclave STRICT · nono-ts seatbelt')
  })
})

describe('Agent session steps', () => {
  it('renders live provider reasoning as an open streaming step', () => {
    const html = renderToStaticMarkup(<ReasoningActivity part={{
      type: 'reasoning',
      state: 'streaming',
      text: 'Inspecting the runtime configuration before choosing a tool.',
    }} />)

    expect(html).toContain('Thinking…')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Inspecting the runtime configuration before choosing a tool.')
    expect(html).toContain('reasoning-cursor')
  })

  it('makes tool steps disclosures so the exact invocation can be inspected', () => {
    const html = renderToStaticMarkup(<ToolActivity part={{
      type: 'tool-runPythonScript',
      state: 'output-available',
      input: { command: 'python /Workspace/check.py --strict' },
      output: { stdout: 'ok', exitCode: 0 },
    }} />)

    expect(html).toContain('Ran command')
    expect(html).toContain('python /Workspace/check.py --strict')
    expect(html).toContain('role="button"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('session-step-chevron')
  })

  it('opens failed tool steps by default with their captured command and error', () => {
    const html = renderToStaticMarkup(<ToolActivity part={{
      type: 'tool-shell',
      state: 'output-error',
      input: { command: 'false' },
      errorText: 'process exited 1',
    }} />)

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('false')
    expect(html).toContain('process exited 1')
  })
})

describe('Agent chat auto-scroll', () => {
  it('follows output while the reader remains near the bottom', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 620, clientHeight: 300 })).toBe(true)
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 300 })).toBe(false)
  })

  it('allows a custom follow threshold', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 650, clientHeight: 300 }, 40)).toBe(false)
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 665, clientHeight: 300 }, 40)).toBe(true)
  })
})