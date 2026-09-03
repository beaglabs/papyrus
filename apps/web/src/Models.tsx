import { useState, type FormEvent } from 'react'
import type { ModelProfile } from '@papyrus/contracts'
import { createModelProfile, deleteModelProfile, disableModelProfile, setDefaultModelProfile, testModelProfile } from './api.js'
import { Alert, Badge, Button, Card } from './components/ui/index.js'

const catalog = [
  { icon: '◎', title: 'OpenAI-compatible', description: 'Hosted or customer-operated endpoints that expose the OpenAI API shape.', prompt: 'Configure an OpenAI-compatible Papyrus model gateway and make it the default.' },
  { icon: '◆', title: 'Azure OpenAI / Entra', description: 'Government-cloud Azure deployments using customer-managed identity or credential references.', prompt: 'Configure an Azure OpenAI Papyrus model gateway using Microsoft Entra authentication.' },
  { icon: '◌', title: 'Ollama / local', description: 'Loopback or enclave-local inference for disconnected and restricted deployments.', prompt: 'Configure an Ollama local Papyrus model gateway and make it the default.' },
  { icon: '⌁', title: 'Custom gateway', description: 'Any approved provider implementing the OpenAI-compatible chat contract.', prompt: 'Configure a custom Papyrus model gateway. Ask me for the endpoint, model, and credential reference.' },
]

const directSetupRequest = {
  fields: [
    { name: 'name', label: 'Display name', kind: 'text', required: true, placeholder: 'Local operations model' },
    { name: 'gatewayKind', label: 'Gateway type', kind: 'select', required: true, options: [{ label: 'OpenAI-compatible', value: 'openai-compatible' }, { label: 'Azure OpenAI / Entra', value: 'azure-openai' }, { label: 'Ollama / local', value: 'ollama' }, { label: 'Custom compatible gateway', value: 'custom' }] },
    { name: 'provider', label: 'Provider name', kind: 'text', required: true, placeholder: 'openai-compatible', help: 'Stable provider label used in the gateway catalog.' },
    { name: 'model', label: 'Model ID', kind: 'text', required: true, placeholder: 'qwen3-32b' },
    { name: 'baseUrl', label: 'Base URL', kind: 'url', required: true, placeholder: 'https://inference.example.gov/v1', help: 'HTTPS is required outside loopback development.' },
    { name: 'authScheme', label: 'Authentication', kind: 'select', required: true, options: [{ label: 'No authentication', value: 'none' }, { label: 'API key reference', value: 'api_key' }, { label: 'Microsoft Entra / managed identity', value: 'entra' }, { label: 'Customer credential reference', value: 'credential_ref' }] },
    { name: 'credentialRef', label: 'Credential reference', kind: 'credential_reference', required: false, placeholder: 'env://OPENAI_API_KEY', help: 'Reference only; raw secret material never enters chat or Papyrus.' },
    { name: 'scope', label: 'Deployment scope', kind: 'text', required: true, placeholder: 'Organization or enclave' },
    { name: 'makeDefault', label: 'Use as default', kind: 'select', required: true, options: [{ label: 'Make default', value: 'true' }, { label: 'Keep current default', value: 'false' }] },
  ],
  note: 'The daemon validates the endpoint, records only non-secret metadata, tests the gateway, and can make it the active Papyrus model.',
}

export function ModelsView({ profiles, onAskAgent, onChanged, canManage }: {
  profiles: ModelProfile[]
  onAskAgent: (prompt: string) => void
  onChanged: () => Promise<void>
  canManage: boolean
}) {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const action = async (profile: ModelProfile, operation: 'test' | 'default' | 'disable' | 'delete') => {
    if (!canManage) return
    if (operation === 'delete' && !window.confirm(`Delete ${profile.name}? The daemon removes its metadata; customer-held credentials are not touched.`)) return
    setBusy(`${operation}:${profile.id}`); setError(undefined)
    try {
      if (operation === 'test') await testModelProfile(profile.id)
      if (operation === 'default') await setDefaultModelProfile(profile.id)
      if (operation === 'disable') await disableModelProfile(profile.id)
      if (operation === 'delete') await deleteModelProfile(profile.id)
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Unable to ${operation} model profile`) }
    finally { setBusy(undefined) }
  }

  return <div className="models-view">
    <section className="surface-intro"><div><p className="eyebrow">CUSTOMER MODEL GATEWAYS</p><h2>Models</h2><p>Choose where Papyrus inference runs. Profiles are durable daemon metadata; the UI stores only a credential reference, never an API key or token.</p></div><Button className="primary" onClick={() => onAskAgent('Configure a Papyrus model gateway. Ask me for the endpoint, model, authentication mode, and credential reference, then test it before making it default.')}>Configure with agent →</Button></section>
    {error && <Alert className="error">{error}</Alert>}
    {canManage && <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">FIRST-RUN SETUP</p><h2>Connect a model gateway</h2></div><Badge>NO CHAT REQUIRED</Badge></div><ModelGatewayCard request={directSetupRequest} onChanged={onChanged} /></section>}
    <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">ACTIVE PROFILES</p><h2>Configured gateways</h2></div><Badge>{profiles.length}</Badge></div>
      {profiles.length === 0 ? <Card className="empty-integration"><span>◎</span><div><h3>No model gateway configured</h3><p>Use the agent-guided form to connect an approved hosted, Azure, or local model endpoint.</p></div></Card> : <div className="model-profile-list">{profiles.map((profile) => <ModelProfileCard key={profile.id} profile={profile} busy={busy} canManage={canManage} onAction={action} />)}</div>}
    </section>
    <section className="portal-section"><div className="section-heading"><div><p className="eyebrow">GATEWAY CATALOG</p><h2>Deployment patterns</h2></div><Badge>{catalog.length}</Badge></div><div className="model-catalog-grid">{catalog.map((entry) => <Card key={entry.title} className="model-catalog-card"><span className="model-catalog-icon">{entry.icon}</span><h3>{entry.title}</h3><p>{entry.description}</p><Button variant="ghost" disabled={!canManage} onClick={() => onAskAgent(entry.prompt)}>Set up with agent →</Button></Card>)}</div></section>
  </div>
}

function ModelProfileCard({ profile, busy, canManage, onAction }: { profile: ModelProfile; busy: string | undefined; canManage: boolean; onAction: (profile: ModelProfile, operation: 'test' | 'default' | 'disable' | 'delete') => Promise<void> }) {
  const stateClass = profile.state === 'active' ? 'status-good' : profile.state === 'error' ? 'status-critical' : 'status-neutral'
  return <Card className={`model-profile-card ${profile.isDefault ? 'default' : ''}`}><div className="model-profile-head"><div><div className="model-profile-title"><span className="model-profile-icon">◎</span><div><h3>{profile.name}</h3><p>{profile.provider} / {profile.model}</p></div></div></div><div className="model-profile-badges">{profile.isDefault && <Badge className="status-info">DEFAULT</Badge>}<Badge className={stateClass}>{profile.state.toUpperCase()}</Badge></div></div><dl className="model-profile-details"><div><dt>Endpoint</dt><dd><code>{profile.baseUrl}</code></dd></div><div><dt>Authentication</dt><dd>{profile.authScheme.replaceAll('_', ' ')}{profile.credentialRef ? <code>{profile.credentialRef}</code> : null}</dd></div><div><dt>Scope</dt><dd>{profile.scope}</dd></div><div><dt>Capabilities</dt><dd>{profile.capabilities.join(' · ')}</dd></div></dl>{profile.lastTestError && <Alert className="error">{profile.lastTestError}</Alert>}{profile.lastTestedAt && <small className="model-profile-tested">Last tested {new Date(profile.lastTestedAt).toLocaleString()}</small>}<div className="model-profile-actions"><Button variant="ghost" size="sm" disabled={!canManage || Boolean(busy)} onClick={() => void onAction(profile, 'test')}>{busy === `test:${profile.id}` ? 'Testing…' : 'Test gateway'}</Button>{!profile.isDefault && <Button variant="ghost" size="sm" disabled={!canManage || Boolean(busy) || profile.state !== 'active'} onClick={() => void onAction(profile, 'default')}>Make default</Button>}{profile.state !== 'disabled' && <Button variant="ghost" size="sm" disabled={!canManage || Boolean(busy)} onClick={() => void onAction(profile, 'disable')}>Disable</Button>}<Button variant="ghost" size="sm" className="danger-item" disabled={!canManage || Boolean(busy)} onClick={() => void onAction(profile, 'delete')}>Delete</Button></div></Card>
}

export function ModelGatewayCard({ request, onChanged }: { request: { fields: Array<{ name: string; label: string; kind: string; required: boolean; placeholder?: string; help?: string; options?: Array<{ label: string; value: string }> }>; note: string }; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<'ready' | 'saving' | 'connected'>('ready')
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setState('saving'); setError(undefined)
    const form = new FormData(event.currentTarget)
    const input: Record<string, unknown> = {}
    for (const field of request.fields) if (field.name !== 'makeDefault') input[field.name] = String(form.get(field.name) ?? '')
    const makeDefault = String(form.get('makeDefault') ?? 'false') === 'true'
    try {
      const profile = await createModelProfile(input)
      await testModelProfile(profile.id)
      if (makeDefault) await setDefaultModelProfile(profile.id)
      setState('connected'); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to configure model gateway'); setState('ready') }
  }
  if (state === 'connected') return <Card className="plugin-tool-card connected"><span className="tool-icon">✓</span><div><strong>Model gateway configured</strong><p>The daemon tested the endpoint and recorded only non-secret profile metadata.</p></div></Card>
  return <Card className="plugin-tool-card model-gateway-card"><div className="plugin-tool-head"><div><p className="eyebrow">SECURE MODEL SETUP</p><h3>Configure model gateway</h3></div><Badge>DAEMON-OWNED</Badge></div><p>Credential references are resolved by the daemon. Do not paste API keys into this conversation.</p><form onSubmit={(event) => void submit(event)}><div className="agent-form-grid">{request.fields.map((field) => <label className="nb-label" key={field.name}>{field.label}{field.kind === 'select' ? <select className="nb-select" name={field.name} required={field.required}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input className="nb-input" name={field.name} type={field.kind === 'credential_reference' ? 'password' : field.kind} required={field.required} placeholder={field.placeholder} autoComplete="off" />}{field.help && <small>{field.help}</small>}</label>)}</div>{error && <Alert className="error">{error}</Alert>}<div className="plugin-tool-foot"><small>{request.note}</small><Button className="primary" disabled={state === 'saving'}>{state === 'saving' ? 'Testing…' : 'Save and test gateway'}</Button></div></form></Card>
}
