import {
  Code2,
  Database,
  FileCheck2,
  Files,
  Globe2,
  LockKeyhole,
  MousePointer2,
  Terminal,
} from 'lucide-react'
import { type ComponentProps, useState } from 'react'
import { PreviewPanel } from './PreviewPanel'

type Props = ComponentProps<typeof PreviewPanel>
const tabs = [
  ['browser', 'Browser', Globe2],
  ['document', 'Document', Files],
  ['data', 'Data', Database],
  ['evidence', 'Evidence', FileCheck2],
  ['terminal', 'Terminal', Terminal],
  ['code', 'Code', Code2],
] as const

export function ToolWorkbench(props: Props) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('browser')
  return (
    <section className="tool-workbench">
      <header className="tool-workbench-tabs">
        {tabs.map(([id, label, Icon]) => (
          <button
            type="button"
            key={id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </header>
      <div className="tool-workbench-body">
        {tab === 'code' ? (
          <PreviewPanel {...props} />
        ) : tab === 'browser' ? (
          <div className="browser-session">
            <header>
              <div>
                <span />
                <span />
                <span />
              </div>
              <div className="browser-address">
                <LockKeyhole size={13} /> https://simulated.cape.local/workflow/AR-026
              </div>
              <button type="button">Take control</button>
            </header>
            <main>
              <aside>
                <b>Stagehand session</b>
                <span className="status-badge passed">Policy allowed</span>
                <ol>
                  <li>Opened acquisition request</li>
                  <li>Read current coordination status</li>
                  <li className="current">
                    <MousePointer2 size={13} /> Awaiting approval to submit
                  </li>
                </ol>
              </aside>
              <section>
                <div className="browser-skeleton">
                  <h2>Acquisition Request AR-026</h2>
                  <p>Simulated CAPE application session</p>
                  <div />
                  <div />
                  <div />
                </div>
              </section>
            </main>
          </div>
        ) : (
          <div className="tool-session-empty">
            <Globe2 size={42} />
            <h2>{tabs.find(([id]) => id === tab)?.[1]} session</h2>
            <p>
              Tool sessions open here with live status, evidence, classification, and takeover
              controls.
            </p>
            <span>Waiting for an agent run</span>
          </div>
        )}
      </div>
    </section>
  )
}
