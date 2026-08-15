import { Activity, ArrowUp, Bot, Check, ChevronDown, Circle, FileText, Globe2, LockKeyhole, MousePointer2, Paperclip, Pause, Play, ShieldCheck, SquareTerminal, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import { ToolWorkbench } from './ToolWorkbench'

export function CapeWorkzone({ projectName }: { projectId: string; projectName: string }) {
  const [prompt, setPrompt] = useState('')
  const [approval, setApproval] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const steps = [
    ['Review request package', 'complete'],
    ['Check funding and routing', 'complete'],
    ['Reconcile coordination comments', 'active'],
    ['Prepare approval package', 'queued'],
  ] as const
  return (
    <div className="cape-workzone">
      <section className="agent-thread">
        <header className="pane-header">
          <div><span className="eyebrow">ACTIVE WORKSPACE</span><h1>{projectName}</h1></div>
          <div className="pane-actions"><button className="outline-button" type="button"><ChevronDown size={15} /> Acquisition analyst</button><button className="outline-button" type="button" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}><Activity size={15} /> Run</button></div>
        </header>
        <div className="thread-scroll">
          <article className="message human-message">
            <div className="message-avatar"><UserRound size={15} /></div>
            <div><b>You</b><p>Review AR-026, reconcile the open coordination comments, and prepare the package for approval.</p></div>
          </article>
          <article className="message agent-message">
            <div className="message-avatar orange"><Bot size={15} /></div>
            <div><b>Papyrus</b><p>I found the request, funding memorandum, and three coordination comments. Two are resolved. One requires a controlled update in the CAPE workflow.</p>
              <div className="source-row"><span><FileText size={13} /> AR-026.pdf</span><span><FileText size={13} /> Funding memo.pdf</span><span><Globe2 size={13} /> CAPE request</span></div>
            </div>
          </article>
          <article className={`approval-card ${approval}`}>
            <header><div className="approval-icon"><MousePointer2 size={18} /></div><div><span>HUMAN APPROVAL REQUIRED</span><h2>Submit coordination response</h2></div><b>CUI</b></header>
            <p>Papyrus is ready to update the acquisition request in the connected CAPE system. This action changes an official business record.</p>
            <dl><div><dt>System</dt><dd>CAPE Business Operations</dd></div><div><dt>Record</dt><dd>AR-026 · Coordination</dd></div><div><dt>Change</dt><dd>Resolve comment 3 with funding citation</dd></div></dl>
            {approval === 'pending' ? <footer><button type="button" className="reject-button" onClick={() => setApproval('rejected')}><X size={15} /> Reject</button><button type="button" className="approve-button" onClick={() => setApproval('approved')}><Check size={15} /> Approve action</button></footer> : <div className="decision-banner">{approval === 'approved' ? <Check size={15} /> : <X size={15} />} Action {approval}</div>}
          </article>
        </div>
        <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); setPrompt('') }}>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask Papyrus to research, analyze, draft, or operate a connected system…" />
          <footer><div><button type="button" aria-label="Attach released material"><Paperclip size={17} /></button><span><ShieldCheck size={13} /> Released context only</span></div><button className="send-button" type="submit" aria-label="Send"><ArrowUp size={17} /></button></footer>
        </form>
      </section>
      <aside className={`run-inspector ${inspectorOpen ? 'open' : ''}`}>
        <header className="pane-header"><div><span className="eyebrow">RUN 24-0187</span><h2>Execution</h2></div><div className="pane-actions"><button type="button" className="icon-button" aria-label="Pause run"><Pause size={15} /></button><button type="button" className="icon-button" aria-label="Close execution panel" onClick={() => setInspectorOpen(false)}><X size={15} /></button></div></header>
        <section className="run-status"><span className="live-dot" /> <b>Waiting for approval</b><small>02:14 elapsed</small></section>
        <section className="plan-section"><header><b>Plan</b><span>2 of 4</span></header><ol>{steps.map(([label, state], index) => <li key={label} className={state}><span>{state === 'complete' ? <Check size={13} /> : state === 'active' ? <Play size={11} /> : <Circle size={10} />}</span><div><b>{label}</b><small>{index === 2 ? 'Approval checkpoint' : state}</small></div></li>)}</ol></section>
        <section className="activity-section"><header><b>Activity</b><button type="button">Evidence</button></header><div><Globe2 size={14} /><p><b>Stagehand</b><span>Read coordination status</span></p><time>2:03</time></div><div><FileText size={14} /><p><b>Documents</b><span>Cited funding paragraph 4</span></p><time>1:41</time></div><div><SquareTerminal size={14} /><p><b>Policy</b><span>Write requires approval</span></p><time>1:29</time></div></section>
        <footer className="run-policy"><LockKeyhole size={14} /><span><b>Role-bounded run</b><small>CAC · CUI · full audit trail</small></span></footer>
      </aside>
      <section className="workbench-pane"><ToolWorkbench generation={null} loading={false} onApprove={() => {}} onReject={() => {}} onFilesUpdate={() => {}} onBuildValidation={() => {}} /></section>
    </div>
  )
}
