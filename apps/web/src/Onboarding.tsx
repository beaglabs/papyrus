import { useCallback, useEffect, useRef, useState } from 'react'
import { activateLicense, bootstrapStatus, completeBootstrap, saveBootstrapConfig, setBootstrapToken, verifyBootstrapToken, type BootstrapStatus } from './api.js'
import { Button } from './components/ui/index.js'

type Step = 'token' | 'license' | 'secret' | 'entra' | 'finalize'
interface Message { role: 'agent' | 'user'; text: string }

function generateSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * First-run onboarding. A scripted (non-LLM) chat drives the operator through the
 * three things the daemon cannot start without: a signed license, a portal secret,
 * and an Entra ID connection. It looks like the agent chat but is a fixed flow —
 * at this point no model is configured, so there is nothing to run an agent on.
 */
export function Onboarding() {
  const [status, setStatus] = useState<BootstrapStatus>()
  const [step, setStep] = useState<Step>('license')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [fatal, setFatal] = useState<string>()

  const [token, setToken] = useState('')
  const [licenseJson, setLicenseJson] = useState('')
  const [secret, setSecret] = useState('')
  const [entra, setEntra] = useState({ tenantId: '', clientId: '', clientSecret: '' })

  const transcriptRef = useRef<HTMLDivElement>(null)
  const finalizedRef = useRef(false)
  const push = useCallback((role: 'agent' | 'user', text: string) => {
    setMessages((existing) => [...existing, { role, text }])
  }, [])

  useEffect(() => {
    void bootstrapStatus()
      .then((s) => {
        setStatus(s)
        setStep('token')
        push('agent', 'Welcome to Papyrus. I\u2019ll walk you through setup: your license, a portal secret, and your Microsoft Entra ID connection.')
        push('agent', 'First, the setup token. It is printed in the daemon logs (docker logs, or the console that launched it). Paste it below to prove you control this deployment.')
      })
      .catch((cause) => setFatal(cause instanceof Error ? cause.message : 'Unable to reach the onboarding service'))
  }, [push])

  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }) }, [messages])

  const submitToken = async () => {
    if (!token.trim()) { push('agent', 'Paste the setup token from the daemon logs first.'); return }
    setBusy(true)
    try {
      await verifyBootstrapToken(token.trim())
      setBootstrapToken(token.trim())
      push('user', 'Setup token accepted')
      if (status && !status.license.valid) {
        setStep('license')
        push('agent', `Your deployment ID is:\n\n${status.deploymentId}\n\nRequest a signed license for this ID from your vendor, then paste the JSON below.`)
      } else if (status && (!status.portalSecretSet || !status.entraSet)) {
        setStep('secret')
        push('agent', 'Token accepted. Next, a portal secret \u2014 32 characters or more. I can generate one for you, or you can paste your own.')
      } else {
        setStep('finalize')
        push('agent', 'Token accepted. Everything else is configured. Finalizing.')
      }
    } catch (cause) {
      push('agent', cause instanceof Error ? cause.message : 'That token is invalid \u2014 check the daemon logs and try again.')
    } finally { setBusy(false) }
  }

  const submitLicense = async () => {
    setBusy(true)
    let document: unknown
    try { document = JSON.parse(licenseJson) } catch { push('agent', 'That isn\u2019t valid JSON. Paste the signed license exactly as it was issued.'); setBusy(false); return }
    push('user', licenseJson.trim())
    try {
      const result = await activateLicense(document as never)
      if (result.valid) {
        push('agent', 'License active. Next, a portal secret \u2014 32 characters or more. I can generate one for you, or you can paste your own.')
        setStep('secret')
      } else {
        push('agent', `That license didn\u2019t validate: ${result.reason ?? 'unknown reason'}.`)
      }
    } catch (cause) { push('agent', cause instanceof Error ? cause.message : 'License activation failed.') }
    finally { setBusy(false) }
  }

  const submitSecret = () => {
    if (secret.length < 32) { push('agent', 'That secret is too short \u2014 give me 32+ characters, or let me generate one.'); return }
    push('user', '•'.repeat(secret.length) + ' (portal secret set)')
    push('agent', 'Got it. Finally, connect your Microsoft Entra ID tenant. I need your tenant ID, the application (client) ID, and its client secret.')
    setStep('entra')
  }

  const submitEntra = async () => {
    if (!entra.tenantId.trim() || !entra.clientId.trim()) { push('agent', 'I need at least the tenant ID and client ID.'); return }
    push('user', `Entra tenant ${entra.tenantId.trim()} / client ${entra.clientId.trim()}`)
    setBusy(true)
    try {
      await saveBootstrapConfig({
        portalSecret: secret,
        entra: { tenantId: entra.tenantId.trim(), clientId: entra.clientId.trim(), ...(entra.clientSecret.trim() ? { clientSecret: entra.clientSecret.trim() } : {}) },
      })
      push('agent', 'Configuration saved. Finalizing setup\u2026')
      setStep('finalize')
    } catch (cause) { push('agent', cause instanceof Error ? cause.message : 'Saving the configuration failed.') }
    finally { setBusy(false) }
  }

  const finalize = async () => {
    if (finalizedRef.current) return
    finalizedRef.current = true
    setBusy(true)
    try {
      const result = await completeBootstrap()
      if (result.complete) {
        push('agent', 'Setup complete. Reloading the portal\u2026')
        setTimeout(() => { window.location.replace('/portal') }, 1200)
      } else {
        push('agent', 'Something is still missing. Check the previous steps and retry.')
        setStep('license')
        finalizedRef.current = false
      }
    } catch (cause) {
      push('agent', cause instanceof Error ? cause.message : 'Finalization failed.')
      finalizedRef.current = false
    } finally { setBusy(false) }
  }

  useEffect(() => { if (step === 'finalize') void finalize() }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  if (fatal) {
    return <main className="onboarding"><div className="onboarding-banner">PAPYRUS SETUP</div><div className="onboarding-shell"><p className="onboarding-fatal">Unable to reach the onboarding service. Is the daemon running?</p><pre>{fatal}</pre></div></main>
  }

  const composer = step === 'token' ? (
    <div className="onboarding-form">
      <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Setup token from daemon logs" autoFocus spellCheck={false} />
      <Button className="primary" disabled={busy || !token.trim()} onClick={() => void submitToken()}>Continue →</Button>
    </div>
  ) : step === 'license' ? (
    <div className="onboarding-form">
      <textarea value={licenseJson} onChange={(event) => setLicenseJson(event.target.value)} placeholder={'{"licenseId": "...", "licensee": "...", "deploymentId": "' + (status?.deploymentId ?? '') + '", "profiles": ["gcc"], "features": [], "keyId": "...", "signature": "..."}'} rows={8} spellCheck={false} />
      <Button className="primary" disabled={busy || !licenseJson.trim()} onClick={() => void submitLicense()}>Activate license →</Button>
    </div>
  ) : step === 'secret' ? (
    <div className="onboarding-form">
      <input value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste a secret, or generate one" />
      <div className="onboarding-row">
        <Button variant="ghost" disabled={busy} onClick={() => setSecret(generateSecret())}>Generate a strong secret</Button>
        <Button className="primary" disabled={busy || secret.length < 32} onClick={submitSecret}>Continue →</Button>
      </div>
    </div>
  ) : step === 'entra' ? (
    <div className="onboarding-form">
      <input value={entra.tenantId} onChange={(event) => setEntra({ ...entra, tenantId: event.target.value })} placeholder="Tenant (directory) ID" />
      <input value={entra.clientId} onChange={(event) => setEntra({ ...entra, clientId: event.target.value })} placeholder="Application (client) ID" />
      <input type="password" value={entra.clientSecret} onChange={(event) => setEntra({ ...entra, clientSecret: event.target.value })} placeholder="Client secret (optional)" />
      <Button className="primary" disabled={busy || !entra.tenantId.trim() || !entra.clientId.trim()} onClick={() => void submitEntra()}>Save configuration →</Button>
    </div>
  ) : (
    <div className="onboarding-form">
      <Button className="primary" disabled={busy} onClick={() => void finalize()}>Complete setup →</Button>
    </div>
  )

  return (
    <main className="onboarding">
      <div className="onboarding-banner">PAPYRUS · FIRST-RUN SETUP</div>
      <div className="onboarding-shell">
        <div className="onboarding-transcript" ref={transcriptRef}>
          {messages.map((message, index) => (
            <div key={index} className={`onboarding-message ${message.role}`}>
              <span className="onboarding-speaker">{message.role === 'agent' ? '✦' : 'You'}</span>
              <div className="onboarding-bubble">{message.text}</div>
            </div>
          ))}
          {busy && <div className="onboarding-message agent"><span className="onboarding-speaker">✦</span><div className="onboarding-bubble">\u2026</div></div>}
        </div>
        <div className="onboarding-composer">{composer}</div>
      </div>
      <style>{`
        .onboarding { min-height: 100vh; background: #0d1117; color: #e6edf3; display: flex; flex-direction: column; }
        .onboarding-banner { padding: 10px 16px; font-size: 12px; letter-spacing: .12em; background: #161b22; color: #8b949e; border-bottom: 1px solid #21262d; }
        .onboarding-shell { flex: 1; display: flex; flex-direction: column; max-width: 820px; width: 100%; margin: 0 auto; }
        .onboarding-transcript { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 14px; }
        .onboarding-message { display: flex; gap: 10px; align-items: flex-start; }
        .onboarding-message.user { flex-direction: row-reverse; }
        .onboarding-speaker { flex: 0 0 auto; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; background: #21262d; color: #8b949e; }
        .onboarding-message.agent .onboarding-speaker { color: #58a6ff; }
        .onboarding-bubble { padding: 12px 14px; border-radius: 12px; background: #161b22; border: 1px solid #21262d; white-space: pre-wrap; line-height: 1.5; font-size: 14px; max-width: 78%; }
        .onboarding-message.user .onboarding-bubble { background: #1f6feb22; border-color: #1f6feb44; }
        .onboarding-composer { padding: 16px 24px 24px; border-top: 1px solid #21262d; background: #0d1117; }
        .onboarding-form { display: flex; flex-direction: column; gap: 10px; }
        .onboarding-form textarea, .onboarding-form input { background: #161b22; border: 1px solid #30363d; color: #e6edf3; border-radius: 8px; padding: 10px 12px; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .onboarding-form textarea:focus, .onboarding-form input:focus { outline: none; border-color: #58a6ff; }
        .onboarding-row { display: flex; gap: 10px; }
        .onboarding-fatal { color: #f85149; }
      `}</style>
    </main>
  )
}
