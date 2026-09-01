import { BrowserViewer } from '@mastra/browser-viewer'

// Only PapyrusService calls these methods after authorization. Do not attach
// this browser to a Workspace: doing so injects a raw CDP endpoint into shell
// tools and moves browser control outside the Cedar boundary.
export class PapyrusBrowser extends BrowserViewer {
  private readonly responseStatus = new Map<string, number>()

  async navigate(sessionId: string, url: string): Promise<void> {
    if (!this.isBrowserRunning(sessionId)) await this.launch(sessionId)
    const page = await this.getActivePage(sessionId)
    if (!page) throw new Error('Session browser is unavailable')
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (response) this.responseStatus.set(sessionId, response.status())
  }

  async readPage(sessionId: string): Promise<{ url: string; title: string; text: string; description?: string; status?: number }> {
    const page = await this.getActivePage(sessionId)
    if (!page) throw new Error('Navigate the session browser before reading it')
    const description = await page.locator('meta[name="description"]').getAttribute('content').catch(() => null)
    const status = this.responseStatus.get(sessionId)
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText({ timeout: 10_000 })).slice(0, 30_000),
      ...(description?.trim() ? { description: description.trim().slice(0, 1_000) } : {}),
      ...(status !== undefined ? { status } : {}),
    }
  }
}
