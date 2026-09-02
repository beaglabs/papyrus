import { useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import type { EntraAppRole, IntegrationCatalogEntry, IntegrationClass, IntegrationConfiguration, IntegrationEvent, PortalPrincipal } from '@papyrus/contracts'
import { createIntegration, integrationEvents, requestIntegrationSync, transitionIntegration } from './api.js'
import { Alert, Badge, Button, Card, Dialog, DialogContent, DialogFooter, DialogHeader, Input, Label, NativeSelect } from './components/ui/index.js'

const CLASS_LABELS: Record<IntegrationClass, string> = {
  human_interface: 'Human interface', evidence_source: 'Evidence source', terrain_source: 'Terrain source',
  action_executor: 'Action executor', agent_peer: 'Agent peer', infrastructure: 'Infrastructure',
}

function can(principal: PortalPrincipal, role: EntraAppRole): boolean {
  return principal.roles.includes('Papyrus.System.Owner') || principal.roles.includes(role)
}

export function IntegrationsView({ me, catalog, integrations, onChanged }: {
  me: PortalPrincipal
  catalog: IntegrationCatalogEntry[]
  integrations: IntegrationConfiguration[]
  onChanged: () => Promise<void>
}) {
  const [filter, setFilter] = useState<'all' | IntegrationClass>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<IntegrationCatalogEntry>()
  const [eventsFor, setEventsFor] = useState<IntegrationConfiguration>()
  const [events, setEvents] = useState<IntegrationEvent[]>([])
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const visibleCatalog = useMemo(() => catalog.filter((entry) => {
    const matchesClass = filter === 'all' || entry.integrationClass === filter
    const haystack = `${entry.name} ${entry.vendor} ${entry.description} ${entry.capabilities.join(' ')}`.toLowerCase()
    return matchesClass && haystack.includes(query.trim().toLowerCase())
  }), [catalog, filter, query])
  const configuredIds = new Set(integrations.map((item) => item.catalogId))
  const canManage = can(me, 'Papyrus.Integration.Manage')
  const canAudit = can(me, 'Papyrus.Audit.View')

  const transition = async (integration: IntegrationConfiguration, action: 'test' | 'submit' | 'activate' | 'disable') => {
    setBusy(`${integration.id}:${action}`); setError(undefined)
    try { await transitionIntegration(integration.id, action); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Integration transition failed') }
    finally { setBusy(undefined) }
  }

  const openEvents = async (integration: IntegrationConfiguration) => {
    setEventsFor(integration); setEvents([]); setError(undefined)
    try { setEvents(await integrationEvents(integration.id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load integration events') }
  }

  const syncNow = async (integration: IntegrationConfiguration) => {
    setBusy(`${integration.id}:sync`); setError(undefined)
    try { await requestIntegrationSync(integration.id); await onChanged() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to queue synchronization') }
    finally { setBusy(undefined) }
  }

  return <div className="integrations-page">
    <section className="integration-summary">
      <div><span className="summary-number">{integrations.length}</span><span>configured</span></div>
      <div><span className="summary-number">{integrations.filter((item) => item.state === 'active').length}</span><span>active</span></div>
      <div><span className="summary-number">{integrations.filter((item) => item.state === 'awaiting_approval').length}</span><span>awaiting approval</span></div>
      <div><span className="summary-number">{integrations.filter((item) => item.health === 'degraded' || item.health === 'unreachable').length}</span><span>degraded</span></div>
    </section>

    {error && <Alert className="error integration-error">{error}<Button variant="ghost" onClick={() => setError(undefined)} aria-label="Dismiss">×</Button></Alert>}

    <section className="portal-section">
      <div className="section-heading"><div><p className="eyebrow">DEPLOYED CONNECTIONS</p><h2>Operational integrations</h2></div><Badge>{integrations.length} TOTAL</Badge></div>
      {integrations.length === 0
        ? <Card className="empty-integration"><span aria-hidden="true">↗</span><div><h3>No integrations configured</h3><p>Connect an operator interface or security evidence source from the catalog below.</p></div></Card>
        : <div className="configured-list">{integrations.map((integration) => {
          const entry = catalog.find((candidate) => candidate.id === integration.catalogId)
          const canActivate = integration.risk === 'high' || integration.risk === 'critical' || integration.authority === 'controlled_actions'
            ? can(me, 'Papyrus.Security.Manage') : canManage
          return <Card className="configured-row" key={integration.id}>
            <div className="connector-mark" style={{ '--connector-accent': entry?.accent ?? '#ece7d8' } as CSSProperties}>{entry?.initials ?? '??'}</div>
            <div className="configured-main"><div className="configured-title"><h3>{integration.name}</h3><Badge className={`state-${integration.state}`}>{integration.state.replaceAll('_', ' ')}</Badge></div><p>{CLASS_LABELS[integration.integrationClass]} · {entry?.syncMode ?? 'none'} · {integration.scope}</p>{integration.lastSyncAt && <small>Last sync {new Date(integration.lastSyncAt).toLocaleString()}</small>}</div>
            <div className="integration-health" title={integration.lastSyncError}><span className={`health-dot ${integration.health}`} />{integration.health}</div>
            <div className="configured-actions">
              {integration.state === 'draft' && canManage && <Button size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'test')}>Test configuration</Button>}
              {integration.state === 'tested' && canManage && <Button size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'submit')}>Submit</Button>}
              {integration.state === 'awaiting_approval' && canActivate && <Button className="primary" size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'activate')}>Activate</Button>}
              {integration.state === 'active' && entry && ['pull', 'hybrid'].includes(entry.syncMode) && canManage && <Button size="sm" disabled={Boolean(busy)} onClick={() => void syncNow(integration)}>Sync now</Button>}
              {integration.state !== 'disabled' && canManage && <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void transition(integration, 'disable')}>Disable</Button>}
              {canAudit && <Button variant="ghost" size="sm" onClick={() => void openEvents(integration)}>Audit</Button>}
            </div>
          </Card>
        })}</div>}
    </section>

    <section className="portal-section catalog-section">
      <div className="section-heading"><div><p className="eyebrow">CONNECTOR CATALOG</p><h2>Add an integration</h2></div><div className="catalog-search"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connectors" aria-label="Search connectors" /></div></div>
      <div className="filter-row">
        <Button size="sm" variant={filter === 'all' ? 'reverse' : 'ghost'} onClick={() => setFilter('all')}>All</Button>
        {Object.entries(CLASS_LABELS).map(([value, label]) => <Button key={value} size="sm" variant={filter === value ? 'reverse' : 'ghost'} onClick={() => setFilter(value as IntegrationClass)}>{label}</Button>)}
      </div>
      <div className="catalog-grid">{visibleCatalog.map((entry) => <Card className="catalog-card" key={entry.id} style={{ '--connector-accent': entry.accent } as CSSProperties}>
        <div className="catalog-card-head"><div className="connector-mark">{entry.initials}</div><Badge className={`risk-${entry.risk}`}>{entry.risk}</Badge></div>
        <p className="catalog-vendor">{entry.vendor}</p><h3>{entry.name}</h3><p>{entry.description}</p>
        <div className="capability-list">{entry.capabilities.slice(0, 3).map((capability) => <span key={capability}>{capability}</span>)}</div>
        <div className="catalog-card-foot"><span>{CLASS_LABELS[entry.integrationClass]}</span><Button disabled={!canManage} onClick={() => setSelected(entry)}>{configuredIds.has(entry.id) ? 'Add another' : 'Configure'} →</Button></div>
      </Card>)}</div>
    </section>

    <ConfigureIntegration entry={selected} open={Boolean(selected)} onClose={() => setSelected(undefined)} onCreated={async () => { setSelected(undefined); await onChanged() }} />
    <Dialog open={Boolean(eventsFor)} onOpenChange={(open) => { if (!open) setEventsFor(undefined) }}><DialogHeader><div><p className="eyebrow">APPEND-ONLY HISTORY</p><h2>{eventsFor?.name}</h2></div><Button variant="ghost" onClick={() => setEventsFor(undefined)}>×</Button></DialogHeader><DialogContent>
      <div className="event-list">{events.length ? events.map((event) => <div key={event.sequence}><span>{event.sequence}</span><div><strong>{event.action}</strong><small>{new Date(event.occurredAt).toLocaleString()} · {event.actorOid}</small></div></div>) : <p className="empty-copy">No audit events available.</p>}</div>
    </DialogContent></Dialog>
  </div>
}

function ConfigureIntegration({ entry, open, onClose, onCreated }: { entry: IntegrationCatalogEntry | undefined; open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!entry) return null
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(undefined)
    const form = new FormData(event.currentTarget)
    try {
      await createIntegration({
        catalogId: entry.id,
        name: String(form.get('name') ?? ''),
        scope: String(form.get('scope') ?? ''),
        ...(form.get('endpoint') ? { endpoint: String(form.get('endpoint')) } : {}),
        ...(form.get('credentialRef') ? { credentialRef: String(form.get('credentialRef')) } : {}),
        settings: { dataHandling: String(form.get('dataHandling') ?? 'metadata_only'), deploymentBoundary: String(form.get('deploymentBoundary') ?? 'internal') },
      })
      await onCreated()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to configure integration') }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}><form onSubmit={submit}>
    <DialogHeader><div><p className="eyebrow">NEW {CLASS_LABELS[entry.integrationClass].toUpperCase()}</p><h2>Configure {entry.name}</h2></div><Button type="button" variant="ghost" onClick={onClose}>×</Button></DialogHeader>
    <DialogContent>{error && <Alert className="error">{error}</Alert>}<div className="connector-intro"><div className="connector-mark" style={{ '--connector-accent': entry.accent } as CSSProperties}>{entry.initials}</div><p>{entry.description}</p></div>
      <div className="form-grid"><Label>Display name<Input name="name" required defaultValue={entry.name} /></Label><Label>Operational scope<Input name="scope" required placeholder="IL4 enterprise enclave" /></Label><Label className="span-two">Endpoint<Input name="endpoint" type="url" placeholder="https://approved.internal.example/api" /><small>HTTPS is required outside loopback development.</small></Label><Label className="span-two">Credential reference<Input name="credentialRef" placeholder="keyvault://papyrus/connectors/example" /><small>Paste a vault, certificate, or managed-identity reference—never a secret.</small></Label><Label>Data handling<NativeSelect name="dataHandling" defaultValue="metadata_only"><option value="metadata_only">Metadata only</option><option value="normalized_evidence">Normalized evidence</option><option value="customer_defined">Customer defined</option></NativeSelect></Label><Label>Deployment boundary<NativeSelect name="deploymentBoundary" defaultValue="internal"><option value="internal">Internal</option><option value="dmz_gateway">DMZ gateway</option><option value="azure_government">Azure Government</option></NativeSelect></Label></div>
      {entry.authority === 'controlled_actions' && <Alert className="authority-warning"><strong>Controlled-action connector</strong><span>Configuration does not grant execution authority. Activation requires the Papyrus.Security.Manage Entra role; individual actions require separate approval.</span></Alert>}
    </DialogContent><DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save draft'}</Button></DialogFooter>
  </form></Dialog>
}
