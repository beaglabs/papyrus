import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Composer } from './Agent.js'

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
