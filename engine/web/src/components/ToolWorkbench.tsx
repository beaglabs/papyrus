import { Code2, Database, FileCheck2, Files, Globe2, Terminal } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { PreviewPanel } from './PreviewPanel'

type Props = ComponentProps<typeof PreviewPanel>
const tabs = [
  ['browser', 'Browser', Globe2], ['document', 'Document', Files], ['data', 'Data', Database],
  ['evidence', 'Evidence', FileCheck2], ['terminal', 'Terminal', Terminal], ['code', 'Code', Code2],
] as const

export function ToolWorkbench(props: Props) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('browser')
  return <section className="tool-workbench">
    <header className="tool-workbench-tabs">
      {tabs.map(([id, label, Icon]) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={14}/>{label}</button>)}
    </header>
    <div className="tool-workbench-body">
      {tab === 'code' ? <PreviewPanel {...props}/> : <div className="tool-session-empty"><Globe2 size={42}/><h2>{tabs.find(([id]) => id === tab)?.[1]} session</h2><p>Tool sessions open here with live status, evidence, classification, and takeover controls.</p><span>Waiting for an agent run</span></div>}
    </div>
  </section>
}
