import { BROWSER_EXECUTABLE_ENV, BROWSER_EXECUTABLE_SETTING } from './executable.js'

/**
 * Rendering a device console through `@mastra/browser-viewer`.
 *
 * Why this file is separate from `session.ts`: an HTTP response and a rendered DOM
 * are two different kinds of evidence. The served bytes say what the device sent; a
 * rendered frame says what the device's own JavaScript decided to show after it ran.
 * Both are useful and neither substitutes for the other, so they get separate
 * transports and a `source` discriminator wherever they are recorded.
 *
 * The hazard this module is built around is that a browser is an *action* machine.
 * `BrowserViewer` exposes `getTools()`, `injectMouseEvent`, `injectKeyboardEvent`,
 * `getCdpUrl()`, and `getActivePageForThread()` returning a Playwright `Page`, which
 * can click, type, submit, and evaluate script. Everything that object can do is
 * reachable from here, so the reach is bounded by type and by construction:
 *
 *   1. The only thing this module hands out is `RenderedDomSource`, whose single
 *      method returns strings. A caller cannot obtain a `Page`, a `CDPSession`, a
 *      context, the CDP URL, or the tool record from a `RenderedDomSource`.
 *   2. `viewer.getTools()` is never called, so no browser tool enters the agent.
 *   3. The navigation performed here is `goto` plus `content()`. No click, no
 *      keyboard event, no `evaluate`, no `fill`, no `submit` exists in this file, and
 *      adding one belongs in the write path behind the proposal flow.
 *   4. The browser is never launched, and `@mastra/browser-viewer` is never even
 *      imported, unless an executable path was configured explicitly. See
 *      `executable.ts` for why that gate is the load-bearing one.
 */

/** One row of the cookie jar, shaped for `BrowserContext.addCookies`. */
export interface RenderCookie {
  name: string
  value: string
}

export interface RenderedFrame {
  /** `document.documentElement.outerHTML` as the browser serialized it. */
  html: string
  /** The URL the frame actually settled on, which a redirect can move. */
  frameUrl: string
  /** HTTP status of the main document, when the browser reported one. */
  status: number | null
  /**
   * Page load steps that were waited for and which of them timed out. A console that
   * never finishes loading still renders a useful frame, but the reader has to be
   * able to tell a quiet device from a slow one.
   */
  settle: { waited: string; incomplete: boolean }
}

/**
 * The whole of what the render host exposes.
 *
 * Deliberately narrow and deliberately string-valued: a caller receives the
 * serialized frame and nothing it can call a method on. This is the boundary that
 * keeps `DeviceConsoleReader` free of any capability to act on a page.
 */
export interface RenderedDomSource {
  render(input: {
    url: string
    cookies?: RenderCookie[]
    timeoutMs?: number
  }): Promise<RenderedFrame>
}

export class RenderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RenderError'
  }
}

/**
 * Launches and drives one browser, kept inside the daemon.
 *
 * One instance serves one integration origin. The browser is created on first render
 * and reused, because launching Chrome per page read on a device console would be
 * slow enough that nothing would use the rendered path.
 */
export class BrowserRenderHost implements RenderedDomSource {
  private viewer: BrowserViewerLike | null = null
  private viewerPromise: Promise<BrowserViewerLike> | null = null
  /** Imported lazily so that an unconfigured host never loads playwright-core. */
  private loadViewer: (() => Promise<new (config: Record<string, unknown>) => BrowserViewerLike>) | null = null
  private closed = false

  constructor(private readonly options: {
      /** Resolves the explicit executable path, or undefined when none is set. */
      executable: () => string | undefined
      /** Refuse to navigate anywhere the integration was not registered for. */
      assertAllowedUrl: (url: string) => void
      /**
       * Thread id passed to BrowserViewer. Scope is per-daemon here, so a shared
       * console renders into one browser rather than one per model thread.
       */
      threadId?: string
      defaultTimeoutMs?: number
      logger?: { warn?: (message: string) => void }
    }) {}

  /**
   * Point the host at a BrowserViewer implementation.
   *
   * Injection exists because the daemon wires the real one while tests wire a stub:
   * there is no browser binary in this repository and no test may download one, so
   * the only honest way to exercise the rendered path is against a fake that returns
   * a fixed serialization, exactly as the real host would.
   */
  useViewerLoader(loader: () => Promise<new (config: Record<string, unknown>) => BrowserViewerLike>): void {
    this.loadViewer = loader
  }

  async render(input: { url: string; cookies?: RenderCookie[]; timeoutMs?: number }): Promise<RenderedFrame> {
    if (this.closed) throw new RenderError('RENDER_HOST_CLOSED', 'This render host was closed; nothing was navigated')
    // Checked before the browser exists. This is the order that keeps a read from
    // ever starting a Chrome process the operator did not configure.
    this.options.assertAllowedUrl(input.url)
    const timeoutMs = input.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
    const viewer = await this.ensureViewer()
    const page = await viewer.getActivePage(this.options.threadId)
    if (!page) throw new RenderError('NO_PAGE', 'The browser is running but reported no active page to read')

    if (input.cookies?.length) {
      const context = await viewer.getContext(this.options.threadId)
      if (!context) throw new RenderError('NO_CONTEXT', 'The browser is running but reported no context to carry cookies in')
      // Cookies are attached to the integration origin only. A jar that could be
      // seeded for any host would turn a render into a way of sending credentials
      // somewhere the console session was never authorized to go.
      await context.addCookies(input.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, url: input.url })))
    }

    let incomplete = false
    let status: number | null = null
    try {
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      status = response ? response.status() : null
    } catch (error) {
      // A console that never finishes loading still has a DOM. Failing the read
      // outright would hide the frame that explains why it is slow, so the timeout
      // is recorded and the serialization is returned anyway.
      incomplete = true
      this.options.logger?.warn?.(`Device console render did not finish loading: ${message(error)}`)
    }
    if (!incomplete) {
      try {
        await page.waitForLoadState('load', { timeout: timeoutMs })
      } catch {
        incomplete = true
      }
    }

    const html = await page.content()
    return {
      html,
      frameUrl: page.url(),
      status,
      settle: {
        waited: 'domcontentloaded+load',
        incomplete,
      },
    }
  }

  /** Release the browser. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true
    const viewer = this.viewer
    this.viewer = null
    this.viewerPromise = null
    if (viewer) await viewer.close().catch(() => undefined)
  }

  private async ensureViewer(): Promise<BrowserViewerLike> {
    if (this.viewer) return this.viewer
    if (this.viewerPromise) return this.viewerPromise
    this.viewerPromise = this.launch().then((viewer) => {
      this.viewer = viewer
      return viewer
    }).finally(() => {
      this.viewerPromise = null
    })
    return this.viewerPromise
  }

  private async launch(): Promise<BrowserViewerLike> {
    // Nothing here has a fallback. `executablePath` is passed only when it was set
    // out in the open, and if it was not, the error says what to write. Letting
    // playwright resolve its own default is how an install ends up chasing a browser
    // download at read time.
    const executablePath = this.options.executable()
    if (!executablePath) throw new BrowserExecutableMissingError()
    const loader = this.loadViewer ?? (async () => {
      const module = await import('@mastra/browser-viewer')
      return module.BrowserViewer as unknown as new (config: Record<string, unknown>) => BrowserViewerLike
    })
    const Viewer = await loader()
    const viewer = new Viewer({
      cli: 'agent-browser',
      headless: true,
      executablePath,
      // 0 lets Chrome take an ephemeral port. It is 0 on purpose rather than a
      // chosen number: this host never calls getCdpUrl() and never hands a debugging
      // endpoint to anything, so there is no reason to pin a memorable port that
      // something else could then connect to.
      cdpPort: 0,
    })
    try {
      await viewer.launch()
    } catch (error) {
      // A launch that fails must not leave a half-attached viewer behind: a retry
      // with a corrected setting should start clean.
      await viewer.close().catch(() => undefined)
      throw new RenderError(
        'BROWSER_LAUNCH_FAILED',
        `The configured browser at ${executablePath} could not be started: ${message(error)} Nothing was rendered.`,
      )
    }
    return viewer
  }
}

const DEFAULT_RENDER_TIMEOUT_MS = 15_000

/**
 * The slice of `BrowserViewer` this host uses.
 *
 * Named members only, and no method that acts on a page: the type is a record of
 * what this file is allowed to do, so widening it is visible in review rather than
 * happening by accident because a richer object was passed through.
 */
export interface BrowserViewerLike {
  launch(): Promise<void>
  close(): Promise<void>
  getActivePage(threadId?: string): Promise<BrowserPageLike | null>
  getContext(threadId?: string): Promise<BrowserContextLike | null>
}

export interface BrowserPageLike {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>
  waitForLoadState(state: string, options: { timeout: number }): Promise<void>
  content(): Promise<string>
  url(): string
}

export interface BrowserContextLike {
  addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>
}

/**
 * Raised when a render was asked for with no browser configured.
 *
 * The message is the product surface here: it has to name both places the operator
 * can set the value and say plainly that Papyrus will not fetch a browser, because
 * the tempting fix for this error is an install step that reaches the network.
 */
export class BrowserExecutableMissingError extends RenderError {
  constructor() {
    super(
      'BROWSER_EXECUTABLE_NOT_CONFIGURED',
      [
        'No browser is configured, so nothing was rendered. Papyrus will not download one.',
        `Set the ${BROWSER_EXECUTABLE_SETTING} setting on the integration, or ${BROWSER_EXECUTABLE_ENV} in the daemon environment,`,
        'to the absolute path of an already-installed Chrome or Chromium binary.',
        'Browsers are installed by the operator, not by the agent, and never by an install script.',
        'To read this page without a browser, use the served-bytes path instead: it extracts tables,',
        'forms, and offsets from the HTTP response directly.',
      ].join(' '),
    )
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One render host per integration, shared by the read tools and the executor.
 *
 * Shared because a browser is a process. Two hosts for one console means two Chromes
 * pointed at one appliance, and the executor's re-render — the check that stops a
 * stale approval being sent — would then be measuring a browser the reader never
 * used. Keyed by integration id, which is also the unit the origin is pinned to.
 */
const hosts = new Map<string, BrowserRenderHost>()

export function getRenderSource(input: {
  integrationId: string
  integrationName: string
  executable: () => string | undefined
  assertAllowedUrl: (url: string) => void
}): RenderedDomSource | null {
  // No executable, no host, and therefore no import of playwright-core. This is the
  // point where "rendering is unavailable" is decided without any network activity.
  if (!input.executable()) return null
  const existing = hosts.get(input.integrationId)
  if (existing) return existing
  const host = new BrowserRenderHost({
    executable: input.executable,
    assertAllowedUrl: input.assertAllowedUrl,
    threadId: `papyrus-console:${input.integrationId}`,
  })
  hosts.set(input.integrationId, host)
  return host
}

/** Release every browser. Called from the daemon shutdown path. */
export async function closeAllRenderHosts(): Promise<void> {
  const open = [...hosts.values()]
  hosts.clear()
  await Promise.all(open.map((host) => host.close()))
}
