import codexLogo from './assets/acp/openai.svg'
import claudeLogo from './assets/acp/claudecode-color.svg'
import openCodeLogo from './assets/acp/opencode.svg'
import './acp-session-connect.css'

type HarnessId = 'codex' | 'claude' | 'opencode'
type HarnessState = 'opening' | 'connected' | 'available' | 'error' | 'closed' | 'disconnected'

interface HarnessStatus {
  harnessId: HarnessId
  name: string
  available: boolean
  connected: boolean
  state: HarnessState
  mode?: 'explicit' | 'opportunistic'
  externalSessionId?: string
  lastError?: string
  scopeId: string
}

const HARNESSES: Array<{ id: HarnessId; name: string; logo: string; description: string }> = [
  { id: 'codex', name: 'Codex', logo: codexLogo, description: 'OpenAI Codex coding harness' },
  { id: 'claude', name: 'Claude', logo: claudeLogo, description: 'Claude Code coding harness' },
  { id: 'opencode', name: 'OpenCode', logo: openCodeLogo, description: 'OpenCode ACP coding harness' },
]

let activeSession: string | undefined
let overlay: HTMLDivElement | undefined
let statusByHarness = new Map<HarnessId, HarnessStatus>()
let observer: MutationObserver | undefined
let scheduled = false

/**
 * Adds a small ACP connection affordance to the top of every Agent session without
 * coupling the durable chat component to any particular coding harness. The actual
 * authority boundary lives on the server: every request below is authenticated and
 * scoped to the Entra principal + Papyrus session before an ACP process can be opened.
 */
export function installAcpSessionConnect(): void {
  if (observer) return
  observer = new MutationObserver(scheduleSync)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('popstate', scheduleSync)
  window.addEventListener('pageshow', scheduleSync)
  scheduleSync()
}

function scheduleSync(): void {
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(() => {
    scheduled = false
    syncStrip()
  })
}

function sessionId(): string | undefined {
  const value = new URLSearchParams(window.location.search).get('session')?.trim()
  return value || undefined
}

function syncStrip(): void {
  const head = document.querySelector<HTMLElement>('.agent-surface > .agent-session-head')
  const session = sessionId()
  if (!head || !session) {
    document.querySelector('.acp-session-connect')?.remove()
    return
  }

  const current = document.querySelector<HTMLElement>('.acp-session-connect')
  if (current?.dataset.session === session && current.previousElementSibling === head) return
  current?.remove()

  const strip = document.createElement('div')
  strip.className = 'acp-session-connect'
  strip.dataset.session = session
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'acp-session-connect-trigger'
  button.setAttribute('aria-haspopup', 'dialog')
  button.innerHTML = `<span class="acp-session-connect-copy"><strong>Connect with</strong><span>Codex, Claude, OpenCode</span></span>${HARNESSES.map((harness) => `<span class="acp-session-logo" title="${escapeHtml(harness.name)}"><img src="${escapeHtml(harness.logo)}" alt=""></span>`).join('')}<span class="acp-session-connect-arrow" aria-hidden="true">→</span>`
  button.addEventListener('click', () => void openDialog(session))
  strip.appendChild(button)
  head.insertAdjacentElement('afterend', strip)
}

async function openDialog(session: string): Promise<void> {
  activeSession = session
  const layer = ensureDialog()
  layer.hidden = false
  document.body.classList.add('acp-dialog-open')
  const first = layer.querySelector<HTMLButtonElement>('.acp-dialog-close')
  first?.focus()
  renderHarnesses({ loading: true })
  try {
    const payload = await request<{ harnesses: HarnessStatus[] }>(`/api/sessions/${encodeURIComponent(session)}/acp`)
    statusByHarness = new Map(payload.harnesses.map((item) => [item.harnessId, item]))
    renderHarnesses()
  } catch (cause) {
    renderHarnesses({ error: errorMessage(cause) })
  }
}

function closeDialog(): void {
  if (!overlay) return
  overlay.hidden = true
  document.body.classList.remove('acp-dialog-open')
  document.querySelector<HTMLButtonElement>('.acp-session-connect-trigger')?.focus()
}

function ensureDialog(): HTMLDivElement {
  if (overlay) return overlay
  overlay = document.createElement('div')
  overlay.className = 'acp-dialog-layer'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="acp-dialog-backdrop" data-acp-close></div>
    <section class="acp-dialog" role="dialog" aria-modal="true" aria-labelledby="acp-dialog-title">
      <header class="acp-dialog-head">
        <div>
          <p class="eyebrow">AGENT CLIENT PROTOCOL</p>
          <h2 id="acp-dialog-title">Open this session in a coding harness</h2>
        </div>
        <button type="button" class="acp-dialog-close" aria-label="Close">×</button>
      </header>
      <p class="acp-dialog-intro">Each connection is isolated to your authenticated Entra identity and this Papyrus session. Papyrus can also delegate coding work to connected ACP harnesses opportunistically when they materially help.</p>
      <div class="acp-dialog-harnesses" data-acp-harnesses></div>
      <footer class="acp-dialog-foot"><span>ACP permissions remain fail-closed behind Papyrus governance.</span></footer>
    </section>`
  overlay.querySelector('.acp-dialog-close')?.addEventListener('click', closeDialog)
  overlay.querySelector('[data-acp-close]')?.addEventListener('click', closeDialog)
  overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDialog() })
  document.body.appendChild(overlay)
  return overlay
}

function renderHarnesses(state: { loading?: boolean; error?: string } = {}): void {
  const host = overlay?.querySelector<HTMLElement>('[data-acp-harnesses]')
  if (!host) return
  if (state.loading) {
    host.innerHTML = '<div class="acp-dialog-loading"><span></span><span></span><span></span> Checking local ACP harnesses…</div>'
    return
  }
  if (state.error) {
    host.innerHTML = `<div class="acp-dialog-error"><strong>Unable to load ACP status</strong><span>${escapeHtml(state.error)}</span></div>`
    return
  }

  host.replaceChildren(...HARNESSES.map((descriptor) => {
    const status = statusByHarness.get(descriptor.id)
    const row = document.createElement('article')
    row.className = `acp-harness-card${status?.connected ? ' is-connected' : ''}${status && !status.available ? ' is-unavailable' : ''}`

    const identity = document.createElement('div')
    identity.className = 'acp-harness-identity'
    identity.innerHTML = `<span class="acp-harness-logo"><img src="${escapeHtml(descriptor.logo)}" alt=""></span><span><strong>${escapeHtml(descriptor.name)}</strong><small>${escapeHtml(descriptor.description)}</small></span>`

    const action = document.createElement('div')
    action.className = 'acp-harness-actions'
    const badge = document.createElement('span')
    badge.className = `acp-harness-state ${status?.connected ? 'connected' : status?.available ? 'available' : 'unavailable'}`
    badge.textContent = status?.connected ? 'CONNECTED' : status?.available ? 'AVAILABLE' : 'NOT INSTALLED'
    action.appendChild(badge)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'acp-harness-open'
    button.disabled = !status?.available || status.connected
    button.textContent = status?.connected ? 'Session open ✓' : `Open in ${descriptor.name} →`
    button.addEventListener('click', () => void connectHarness(descriptor.id, button))
    action.appendChild(button)

    if (status?.connected) {
      const disconnect = document.createElement('button')
      disconnect.type = 'button'
      disconnect.className = 'acp-harness-disconnect'
      disconnect.textContent = 'Disconnect'
      disconnect.addEventListener('click', () => void disconnectHarness(descriptor.id, disconnect))
      action.appendChild(disconnect)
    }

    row.append(identity, action)
    if (status?.lastError) {
      const failure = document.createElement('p')
      failure.className = 'acp-harness-error'
      failure.textContent = status.lastError
      row.appendChild(failure)
    }
    if (status?.connected && status.externalSessionId) {
      const scope = document.createElement('p')
      scope.className = 'acp-harness-scope'
      scope.textContent = `ACP session ${status.externalSessionId}`
      row.appendChild(scope)
    }
    return row
  }))
}

async function connectHarness(id: HarnessId, button: HTMLButtonElement): Promise<void> {
  if (!activeSession) return
  const original = button.textContent
  button.disabled = true
  button.textContent = 'Opening…'
  try {
    const payload = await request<{ harness: HarnessStatus }>(`/api/sessions/${encodeURIComponent(activeSession)}/acp/${id}/connect`, { method: 'POST' })
    statusByHarness.set(id, payload.harness)
    renderHarnesses()
  } catch (cause) {
    const previous = statusByHarness.get(id)
    if (previous) statusByHarness.set(id, { ...previous, state: 'error', lastError: errorMessage(cause) })
    else renderHarnesses({ error: errorMessage(cause) })
    renderHarnesses()
  } finally {
    if (button.isConnected) {
      button.disabled = false
      button.textContent = original
    }
  }
}

async function disconnectHarness(id: HarnessId, button: HTMLButtonElement): Promise<void> {
  if (!activeSession) return
  button.disabled = true
  button.textContent = 'Disconnecting…'
  try {
    await request(`/api/sessions/${encodeURIComponent(activeSession)}/acp/${id}/disconnect`, { method: 'DELETE' })
    const current = statusByHarness.get(id)
    if (current) statusByHarness.set(id, { ...current, connected: false, state: 'closed', externalSessionId: undefined })
    renderHarnesses()
  } catch (cause) {
    const current = statusByHarness.get(id)
    if (current) statusByHarness.set(id, { ...current, lastError: errorMessage(cause) })
    renderHarnesses()
  }
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { accept: 'application/json', ...init?.headers } })
  const payload = await response.json().catch(() => null) as T | { error?: string }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : `Request failed (${response.status})`
    throw new Error(message)
  }
  return payload as T
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unexpected ACP error'
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string)
}
