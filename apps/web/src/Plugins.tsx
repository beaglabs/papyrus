import { useMemo, useState, type CSSProperties } from 'react'
import type { IntegrationCatalogEntry, IntegrationConfiguration } from '@papyrus/contracts'
import { deleteIntegration, requestIntegrationSync } from './api.js'
import { Alert, Badge, Button, Card, Input } from './components/ui/index.js'

const PLUGIN_LOGO_SOURCES: Record<string, string> = {
  'exchange-email': 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ea/Microsoft_Exchange_%282019-present%29.svg/1280px-Microsoft_Exchange_%282019-present%29.svg.png',
  zeek: 'https://old.zeek.org/images/zeek-logo-without-text.png',
  suricata: 'https://suricata.io/wp-content/uploads/2023/09/Suricata_logo_600x600-1.png',
  sysmon: 'https://github.com/sysinternals.png?size=256',
  'dns-observation': 'https://storage.ghost.io/c/08/96/08960c71-63a2-449b-91b1-8d4628166dd2/content/images/2021/03/azuredns-1.png',
  'asset-inventory': 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e3/Microsoft_Office_Excel_%282019%E2%80%932025%29.svg/960px-Microsoft_Office_Excel_%282019%E2%80%932025%29.svg.png',
  'firewall-executor': 'https://cdn-icons-png.flaticon.com/512/811/811683.png',
  'a2a-peer': 'https://github.com/a2aproject.png?size=256',
}

export function pluginLogoUrl(id: string): string | undefined {
  const source = PLUGIN_LOGO_SOURCES[id]
  return source ? `/api/url-preview/image?url=${encodeURIComponent(source)}` : undefined
}

function PluginMark({ id, initials, compact = false }: { id: string; initials: string; compact?: boolean }) {
  const logo = pluginLogoUrl(id)
  return <div className={`connector-mark${compact ? ' compact' : ''}`}><span>{initials}</span>{logo && <img src={logo} alt="" loading="lazy" onError={(event) => event.currentTarget.remove()} />}</div>
}

export function PluginsView({ catalog, configured, onAskAgent, onChanged, canManage }: {
  catalog: IntegrationCatalogEntry[]
  configured: IntegrationConfiguration[]
  onAskAgent: (prompt: string) => void
  onChanged: () => Promise<void>
  canManage: boolean
}) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const visible = useMemo(() => catalog.filter((entry) => `${entry.name} ${entry.vendor} ${entry.description} ${entry.capabilities.join(' ')}`.toLowerCase().includes(query.toLowerCase())), [catalog, query])
  const remove = async (plugin: IntegrationConfiguration) => {
    if (!window.confirm(`Delete ${plugin.name}? Accepted signals and action receipts remain in the daemon audit record.`)) return
    setBusy(plugin.id); setError(undefined)
    try { await deleteIntegration(plugin.id); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete plugin') }
    finally { setBusy(undefined) }
  }
  const sync = async (plugin: IntegrationConfiguration) => {
    setBusy(plugin.id); setError(undefined)
    try { await requestIntegrationSync(plugin.id); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to queue plugin sync') }
    finally { setBusy(undefined) }
  }
  return <div className="plugins-view"><section className="surface-intro"><div><p className="eyebrow">AGENT-AVAILABLE CAPABILITIES</p><h2>Plugins</h2><p>Every catalog entry is available to the agent as a typed connection tool. Configuration opens inside the conversation; credentials go directly to this daemon.</p></div><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins" aria-label="Search plugins" /></section>
    {error && <Alert className="error">{error}</Alert>}
    {configured.length > 0 && <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">CONNECTED</p><h2>Installed plugins</h2></div><Badge>{configured.length}</Badge></div><div className="plugin-installed-list">{configured.map((plugin) => {
      const entry = catalog.find((candidate) => candidate.id === plugin.catalogId)
      const syncable = plugin.state === 'active' && Boolean(entry && ['pull', 'hybrid'].includes(entry.syncMode))
      return <Card key={plugin.id}><PluginMark id={plugin.catalogId} initials={entry?.initials ?? plugin.catalogId.slice(0, 2).toUpperCase()} compact /><span className={`health-dot ${plugin.health}`} /><div><strong>{plugin.name}</strong><small>{plugin.catalogId} · {plugin.scope}</small>{plugin.lastEvidenceAt && <small>Last signal {new Date(plugin.lastEvidenceAt).toLocaleString()}</small>}</div><Badge className={`state-${plugin.state}`}>{plugin.state.replaceAll('_', ' ')}</Badge><div className="plugin-installed-actions">{syncable && <Button variant="ghost" size="sm" disabled={!canManage || busy === plugin.id} onClick={() => void sync(plugin)}>Sync now</Button>}<Button variant="ghost" size="sm" disabled={!canManage || busy === plugin.id} onClick={() => void remove(plugin)}>Delete</Button></div></Card>
    })}</div></section>}
    <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">CATALOG</p><h2>Available to Papyrus</h2></div><Badge>{visible.length} TOOLS</Badge></div><div className="plugin-grid">{visible.map((entry) => {
      const installed = configured.some((plugin) => plugin.catalogId === entry.id && plugin.state !== 'disabled')
      return <Card key={entry.id} style={{ '--connector-accent': entry.accent } as CSSProperties}><div className="catalog-card-head"><PluginMark id={entry.id} initials={entry.initials} /><Badge>{entry.risk}</Badge></div><small>{entry.vendor}</small><h3>{entry.name}</h3><p>{entry.description}</p><div className="capability-list">{entry.capabilities.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div><div className="plugin-card-foot"><span>{installed ? 'Connected' : entry.integrationClass.replaceAll('_', ' ')}</span><Button className="primary" onClick={() => onAskAgent(`Connect ${entry.name} and guide me through the required configuration.`)}>{installed ? 'Configure another' : 'Connect with agent'} →</Button></div></Card>
    })}</div></section>
  </div>
}
