import { Stagehand, localBrowser } from '@browserbasehq/stagehand'
import type { ToolSession } from '@papyrus/core'

export interface BrowserPolicy {
  allowedOrigins: string[]
  blockedOrigins?: string[]
  downloads: 'deny' | 'quarantine'
  credentialRefs: string[]
}

export interface ManagedBrowserSession {
  session: ToolSession
  navigate(url: string): Promise<void>
  act(instruction: string): Promise<unknown>
  observe(instruction: string): Promise<unknown>
  screenshot(): Promise<string>
  close(): Promise<void>
}

function assertAllowed(rawUrl: string, policy: BrowserPolicy): void {
  const origin = new URL(rawUrl).origin
  if (policy.blockedOrigins?.includes(origin) || !policy.allowedOrigins.includes(origin)) {
    throw new Error(`Browser destination is not permitted: ${origin}`)
  }
}

export async function launchManagedBrowser(
  runId: string,
  classification: string,
  policy: BrowserPolicy,
): Promise<ManagedBrowserSession> {
  const browser = await localBrowser.launch({ headless: false })
  const stagehand = await Stagehand.create({ browser })
  const now = new Date().toISOString()
  const session: ToolSession = {
    id: `browser-${crypto.randomUUID()}`,
    runId,
    kind: 'browser',
    title: 'Stagehand browser',
    status: 'active',
    classification,
    startedAt: now,
    updatedAt: now,
  }
  return {
    session,
    async navigate(url) {
      assertAllowed(url, policy)
      const [page] = await browser.context.pages()
      if (!page) throw new Error('Browser session has no active page')
      await page.goto(url)
    },
    act: (instruction) => stagehand.act(instruction),
    observe: (instruction) => stagehand.observe(instruction),
    async screenshot() {
      const [page] = await browser.context.pages()
      if (!page) throw new Error('Browser session has no active page')
      return Buffer.from(await page.screenshot({ type: 'png' })).toString('base64')
    },
    async close() {
      await stagehand.close()
      await browser.close()
      session.status = 'closed'
      session.endedAt = new Date().toISOString()
    },
  }
}
