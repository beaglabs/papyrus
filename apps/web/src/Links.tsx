import { useEffect, useMemo, useState } from 'react'
import type { AgentLink, LinkInbound, LinkType } from '@papyrus/contracts'
import { linkContentUrl, linkInboundUrl, linkInbounds, listLinks, publicLinkUrl, workspaceFileContentUrl } from './api.js'
import { Alert, Badge, Button, Input, Skeleton } from './components/ui/index.js'

type LinkFilter = 'all' | LinkType

export function LinksView({ validation }: { validation?: 'local-static' | 'kitesurf' }) {
  const [links, setLinks] = useState<AgentLink[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LinkFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = async () => {
    try {
      setError(undefined)
      setLinks(await listLinks())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load Links')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 12_000)
    return () => window.clearInterval(timer)
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return links.filter((link) =>
      (filter === 'all' || link.type === filter) &&
      (!needle || link.name.toLowerCase().includes(needle) || link.slug.includes(needle) || link.type.includes(needle)))
  }, [links, query, filter])

  return <div className="links-view">
    <header className="links-head">
      <div className="links-title"><h2>Links</h2><span>{links.length}</span></div>
      <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search links…" aria-label="Search Links" />
    </header>

    <nav className="links-tabs" aria-label="Link types">
      <LinkTab active={filter === 'all'} onClick={() => setFilter('all')} icon="◎">All</LinkTab>
      <LinkTab active={filter === 'webpage'} onClick={() => setFilter('webpage')} icon="◉">Webpage</LinkTab>
      <LinkTab active={filter === 'api'} onClick={() => setFilter('api')} icon="〈〉">API</LinkTab>
      <LinkTab active={filter === 'webhook'} onClick={() => setFilter('webhook')} icon="ϟ">Webhook</LinkTab>
      <span className="links-validation">PREVIEW · {(validation ?? 'local-static').toUpperCase()}</span>
    </nav>

    {error && <Alert className="error">{error}</Alert>}
    <main className="links-grid" aria-busy={loading}>
      {loading && links.length === 0
        ? Array.from({ length: 3 }, (_, index) => <Skeleton className="link-card-skeleton" key={index} />)
        : visible.map((link) => <LinkCard link={link} key={link.id} />)}
      {!loading && visible.length === 0 && <div className="links-empty"><span>◎</span><h3>{links.length ? 'No matching Links' : 'No Links yet'}</h3><p>{links.length ? 'Try another type or search.' : 'Ask Papyrus to create a Webpage, API, or Webhook. The agent will ask before exposing anything.'}</p></div>}
    </main>
  </div>
}

function LinkTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: string }) {
  return <button type="button" className={active ? 'active' : ''} aria-pressed={active} onClick={onClick}><span>{icon}</span>{children}</button>
}

function LinkCard({ link }: { link: AgentLink }) {
  const url = publicLinkUrl(link)
  const [copied, setCopied] = useState(false)
  const [showInbounds, setShowInbounds] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return <article className="link-card">
    <div className="link-preview">
      {link.type === 'webpage' && <iframe src={link.publicPath} title={`${link.name} preview`} sandbox="" loading="lazy" />}
      {link.type === 'api' && <ApiPreview url={link.publicPath} />}
      {link.type === 'webhook' && <WebhookPreview link={link} />}
      <Badge className="link-type-badge">{link.type.toUpperCase()} ↗</Badge>
    </div>
    <div className="link-card-body">
      <div className="link-card-title"><a href={url} target="_blank" rel="noreferrer">{link.name}</a><Badge>{link.state.toUpperCase()}</Badge></div>
      <div className="link-meta">
        <span className="link-live-dot" />Live<span>·</span><span>{link.pingCount} pings</span><span>·</span>
        <button type="button" className="link-inbound-toggle" aria-expanded={showInbounds} onClick={() => setShowInbounds((open) => !open)}>
          {link.inboundCount} inbounds {showInbounds ? '▴' : '▾'}
        </button>
      </div>
      {showInbounds && <LinkInbounds link={link} />}
      <div className="link-card-foot"><span>{link.type === 'webhook' && link.threadId ? `Session · ${shortId(link.threadId)}` : link.workflowId ? `Workflow · ${link.workflowId}` : link.scheduleId ? `Schedule · ${link.scheduleId}` : 'General'}</span><span>{link.type === 'webhook' ? 'Mastra Webhook Signal' : link.validationProvider ? `Validated · ${link.validationProvider}` : 'Approved snapshot'}</span><span className="link-card-foot-actions"><a className="link-snapshot" href={linkContentUrl(link.id, true)} title="Download the approved snapshot this Link serves">Snapshot ↓</a><Button variant="ghost" onClick={() => void copy()} aria-label={`Copy ${link.name} Link`}>{copied ? 'Copied ✓' : 'Copy link'}</Button></span></div>
    </div>
  </article>
}

/**
 * What actually arrived on a Link, and the only place it can be read back.
 *
 * A workflow-bound API Link answers GET by running its workflow, so the pinned snapshot is not
 * retrievable through the Link itself, and inbound records were previously only reachable by
 * listing metadata, copying a blob path out of it, and reading that path as a workspace file.
 * Both are served from authenticated portal routes here; the Link URL is a public boundary and
 * inbound traffic is customer data, so none of this is exposed there.
 */
function LinkInbounds({ link }: { link: AgentLink }) {
  const [inbounds, setInbounds] = useState<LinkInbound[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    linkInbounds(link.id).then((records) => { if (active) setInbounds(records) })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load inbound records') })
    return () => { active = false }
  }, [link.id])

  if (error) return <p className="link-inbounds-empty">{error}</p>
  if (!inbounds) return <p className="link-inbounds-empty">Loading received records…</p>
  if (!inbounds.length) return <p className="link-inbounds-empty">Nothing has arrived on this Link yet.</p>

  return <ul className="link-inbounds">
    {inbounds.map((record) => <li key={record.id}>
      <span className="link-inbounds-method">{record.method}</span>
      <span className="link-inbounds-when">{new Date(record.receivedAt).toLocaleString()}</span>
      <span className="link-inbounds-size">{record.size} B</span>
      <span className="link-inbounds-actions">
        <a href={linkInboundUrl(link.id, record.id)} target="_blank" rel="noreferrer">View</a>
        <a href={linkInboundUrl(link.id, record.id, true)} download>Download</a>
      </span>
    </li>)}
  </ul>
}

function WebhookPreview({ link }: { link: AgentLink }) {
  const logoUrl = link.logoPath ? workspaceFileContentUrl(link.logoPath) : undefined
  return <div className="webhook-preview">
    <div className="webhook-logo">
      {logoUrl
        ? <img src={logoUrl} alt={`${link.name} logo`} loading="lazy" />
        : <span aria-hidden="true">{link.logoText || 'ϟ'}</span>}
    </div>
    <strong>{link.name}</strong>
    <small>{link.threadId ? `Session-scoped · ${shortId(link.threadId)}` : 'Webhook'}</small>
    <code>{link.publicPath}</code>
  </div>
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function ApiPreview({ url }: { url: string }) {
  const [text, setText] = useState('Loading API preview…')
  useEffect(() => {
    let active = true
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const value = await response.text()
        if (!response.ok) throw new Error(value)
        try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
      })
      .then((value) => { if (active) setText(value.slice(0, 1800)) })
      .catch(() => { if (active) setText('API preview unavailable') })
    return () => { active = false }
  }, [url])
  return <pre className="api-link-preview">{text}</pre>
}
