import { ContentBlock } from './AcpSessionContent.js'

export interface ToolActivity {
  id: string
  title: string
  kind: string
  status: string
  sequence: number
  locations: string[]
  terminals: string[]
  output: Array<Record<string, unknown>>
  stdout: string
  stderr: string
  exitCode?: number
}

export interface PlanItem {
  content: string
  status: string
  priority: string
}

export interface BrowserToolPreview {
  url?: string
  title?: string
  text?: string
  description?: string
  status?: number
}

export function ToolActivityGroup({ tools, running }: { tools: ToolActivity[]; running: boolean }) {
  const visibleTools = tools.filter((tool) => !isInputTool(tool))
  if (visibleTools.length === 0) return null

  const active = visibleTools.filter((tool) => tool.status === 'pending' || tool.status === 'in_progress').length
  const failed = visibleTools.filter((tool) => tool.status === 'failed').length
  const completed = visibleTools.filter((tool) => tool.status === 'completed').length

  return <section className="session-activity" aria-label="Tool activity">
    <div className="session-activity-header">
      <span className={`session-activity-led ${failed ? 'failed' : active ? 'running' : 'completed'}`} aria-hidden="true" />
      <strong>Activity</strong>
      <span>{activitySummary(visibleTools.length, active, completed, failed)}</span>
    </div>
    <div className="session-activity-list">
      {visibleTools.map((tool) => <ToolActivityRow key={tool.id} tool={tool} active={running && (tool.status === 'pending' || tool.status === 'in_progress')} />)}
    </div>
  </section>
}

function ToolActivityRow({ tool, active }: { tool: ToolActivity; active: boolean }) {
  const browser = browserToolPreview(tool)
  const summary = toolSummary(tool, browser)
  const hasDetail = Boolean(browser) || Boolean(tool.stdout || tool.stderr) || tool.output.length > 0 || tool.exitCode !== undefined || tool.status === 'failed'
  const open = tool.status === 'failed' || (active && Boolean(tool.stdout || tool.stderr))
  const row = <ToolActivitySummary tool={tool} active={active} summary={summary} />

  if (!hasDetail) {
    return <div className={`session-tool-row ${tool.status}`} aria-busy={active}>{row}</div>
  }

  return <details className={`session-tool-row ${tool.status}`} open={open} aria-busy={active}>
    <summary>{row}</summary>
    <div className="session-tool-detail">
      {browser ? <BrowserPreview preview={browser} /> : <ToolOutput tool={tool} />}
      {browser && tool.output.length > 0 && <details className="session-tool-raw">
        <summary>Raw response</summary>
        <div className="session-tool-output">{tool.output.map((block, index) => <ContentBlock key={index} block={block} />)}</div>
      </details>}
      {tool.status === 'failed' && !tool.stdout && !tool.stderr && tool.output.length === 0 && <div className="session-tool-error">
        {tool.exitCode !== undefined ? `Exited with code ${tool.exitCode} without diagnostic output.` : 'Tool failed without diagnostic output.'}
      </div>}
      {tool.exitCode !== undefined && <small className="session-tool-exit">Exit code {tool.exitCode}</small>}
    </div>
  </details>
}

function ToolActivitySummary({ tool, active, summary }: { tool: ToolActivity; active: boolean; summary: string }) {
  return <>
    <span className={`session-tool-dot ${tool.status}`} aria-hidden="true">{active && <span className="session-tool-spinner" />}</span>
    <strong className="session-tool-name">{displayToolTitle(tool.title)}</strong>
    <span className="session-tool-summary">{summary}</span>
    <span className="session-tool-state">{statusLabel(tool.status)}</span>
  </>
}

function ToolOutput({ tool }: { tool: ToolActivity }) {
  if (!tool.stdout && !tool.stderr && tool.output.length === 0) return null
  return <>
    {(tool.stdout || tool.stderr) && <pre className="session-terminal-output">{tool.stdout}{tool.stderr && <span className="session-terminal-stderr">{tool.stderr}</span>}</pre>}
    {tool.output.length > 0 && <div className="session-tool-output">{tool.output.map((block, index) => <ContentBlock key={index} block={block} />)}</div>}
  </>
}

function BrowserPreview({ preview }: { preview: BrowserToolPreview }) {
  const url = safeBrowserUrl(preview.url)
  const hostname = url ? new URL(url).hostname : undefined
  const snippet = compactToolText(preview.description || preview.text || '', 520)
  const error = typeof preview.status === 'number' && preview.status >= 400
  return <article className={`session-browser-preview ${error ? 'error' : ''}`}>
    <div className="session-browser-preview-meta">
      <span>{hostname || 'Browser page'}</span>
      {preview.status !== undefined && <span>HTTP {preview.status}</span>}
    </div>
    <strong>{preview.title?.trim() || hostname || 'Browser result'}</strong>
    {url && <a href={url} target="_blank" rel="noreferrer">{url}</a>}
    {snippet && <p>{snippet}</p>}
  </article>
}

export function browserToolPreview(tool: Pick<ToolActivity, 'title' | 'output'>): BrowserToolPreview | undefined {
  if (!isBrowserTool(tool)) return undefined
  for (const block of [...tool.output].reverse()) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed = JSON.parse(block.text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const value = parsed as Record<string, unknown>
      const preview: BrowserToolPreview = {
        ...(typeof value.url === 'string' ? { url: value.url } : {}),
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(typeof value.status === 'number' ? { status: value.status } : {}),
      }
      if (preview.url || preview.title || preview.text || preview.description) return preview
    } catch {
      // Non-JSON browser integrations fall through to the compact generic summary.
    }
  }
  return undefined
}

export function displayToolTitle(title: string): string {
  const exact: Record<string, string> = {
    papyrus_browser_navigate: 'Open page',
    papyrus_browser_read: 'Read page',
    'Browser navigate': 'Open page',
    'Browser read': 'Read page',
    papyrus_request_input: 'Request input',
    papyrus_set_goal: 'Update goal',
    papyrus_create_pdf: 'Create PDF',
    mastra_workspace_list_files: 'List files',
    mastra_workspace_read_file: 'Read file',
    mastra_workspace_write_file: 'Write file',
    mastra_workspace_execute_command: 'Run command',
  }
  if (exact[title]) return exact[title]
  if (!title.includes('_')) return title

  const normalized = title.startsWith('mastra_workspace_') ? title.slice('mastra_workspace_'.length)
    : title.startsWith('papyrus_') ? title.slice('papyrus_'.length)
    : title
  return normalized.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

export function projectActivity(events: Array<{ kind: string; sequence: number; data?: unknown }>): { plan: PlanItem[]; tools: ToolActivity[] } {
  let plan: PlanItem[] = []
  const tools = new Map<string, ToolActivity>()
  for (const event of events) {
    if (event.kind !== 'update' || !event.data || typeof event.data !== 'object') continue
    const update = event.data as {
      sessionUpdate?: string
      entries?: PlanItem[]
      toolCallId?: string
      title?: string
      kind?: string
      status?: string
      locations?: Array<{ path?: string }>
      content?: Array<{ type?: string; terminalId?: string; content?: unknown }>
      _meta?: { papyrus?: { outputDelta?: { stream?: string; text?: string }; exitCode?: number } }
    }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) plan = update.entries
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
      const current = tools.get(update.toolCallId)
      const locations = update.locations?.flatMap((location) => typeof location.path === 'string' ? [location.path] : []) ?? []
      const terminals = update.content?.flatMap((content) => content.type === 'terminal' && content.terminalId ? [content.terminalId] : []) ?? []
      const output = update.content?.flatMap((content) => content.type === 'content' && content.content && typeof content.content === 'object' && !Array.isArray(content.content) ? [content.content as Record<string, unknown>] : []) ?? []
      const delta = update._meta?.papyrus?.outputDelta
      const appendOutput = (channel: string, currentText = '') => (currentText + (delta?.stream === channel && typeof delta.text === 'string' ? delta.text : '')).slice(-65_536)
      const exitCode = update._meta?.papyrus?.exitCode ?? current?.exitCode
      tools.set(update.toolCallId, {
        id: update.toolCallId,
        title: update.title ?? current?.title ?? 'Tool activity',
        kind: update.kind ?? current?.kind ?? 'other',
        status: update.status ?? current?.status ?? 'pending',
        sequence: current?.sequence ?? event.sequence,
        locations: [...new Set([...(current?.locations ?? []), ...locations])],
        terminals: [...new Set([...(current?.terminals ?? []), ...terminals])],
        output: mergeToolOutput(current?.output ?? [], output),
        stdout: appendOutput('stdout', current?.stdout),
        stderr: appendOutput('stderr', current?.stderr),
        ...(exitCode !== undefined ? { exitCode } : {}),
      })
    }
  }
  return { plan, tools: [...tools.values()].sort((left, right) => left.sequence - right.sequence) }
}

function toolSummary(tool: ToolActivity, browser?: BrowserToolPreview): string {
  if (browser) {
    const url = safeBrowserUrl(browser.url)
    const host = url ? new URL(url).hostname : ''
    return [host, browser.title?.trim(), browser.status !== undefined ? `HTTP ${browser.status}` : ''].filter(Boolean).join(' · ') || 'Page preview available'
  }
  if (tool.locations.length) return compactToolText(tool.locations.join(' · '), 132)
  const stream = (tool.stderr || tool.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (stream) return compactToolText(stream, 132)
  const output = tool.output.find((block) => block.type === 'text' && typeof block.text === 'string')
  if (output && typeof output.text === 'string') return compactToolText(output.text, 132)
  if (tool.status === 'pending') return 'Preparing'
  if (tool.status === 'in_progress') return 'Working'
  return 'No additional output'
}

function activitySummary(total: number, active: number, completed: number, failed: number): string {
  if (active) return `${active} running · ${completed} done`
  if (failed) return `${total} step${total === 1 ? '' : 's'} · ${failed} failed`
  return `${total} step${total === 1 ? '' : 's'} · complete`
}

function statusLabel(status: string): string {
  if (status === 'in_progress') return 'Running'
  if (status === 'pending') return 'Preparing'
  if (status === 'completed') return 'Done'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  return status.replaceAll('_', ' ')
}

function isInputTool(tool: Pick<ToolActivity, 'title'>): boolean {
  return tool.title === 'papyrus_request_input' || /request input/i.test(tool.title)
}

function isBrowserTool(tool: Pick<ToolActivity, 'title'>): boolean {
  return tool.title.startsWith('papyrus_browser_') || /browser|navigate|open page|read page/i.test(tool.title)
}

function compactToolText(text: string, limit: number): string {
  const compact = text.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact
}

function safeBrowserUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function mergeToolOutput(current: Array<Record<string, unknown>>, incoming: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged = new Map(current.map((block) => [JSON.stringify(block), block]))
  for (const block of incoming) merged.set(JSON.stringify(block), block)
  return [...merged.values()]
}
