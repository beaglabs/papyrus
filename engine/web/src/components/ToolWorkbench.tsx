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

export interface WorkbenchSession {
  id: string
  kind: string
  title: string
  status: string
  classification: string
  metadata: Record<string, unknown>
  takeoverBy?: string
}
type Props = ComponentProps<typeof PreviewPanel> & {
  runMode?: boolean
  sessions?: WorkbenchSession[]
  activity?: Array<{
    id: string
    kind: string
    occurredAt: string
    payload: Record<string, unknown>
  }>
  busy?: boolean
  browserFrame?: string
  onStartBrowser?: (url: string) => Promise<void>
  onTakeover?: (sessionId: string, takeover: boolean) => Promise<void>
  onBrowserAction?: (sessionId: string, instruction: string) => Promise<void>
}
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
  const [url, setUrl] = useState('')
  const [instruction, setInstruction] = useState('')
  const session = props.sessions?.find((item) => item.kind === tab)
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
        {!props.runMode && tab === 'code' ? (
          <PreviewPanel {...props} />
        ) : props.runMode && tab === 'browser' && session ? (
          <div className="browser-session">
            <header>
              <div>
                <span />
                <span />
                <span />
              </div>
              <div className="browser-address">
                <LockKeyhole size={13} />{' '}
                {String(session.metadata.url ?? 'Local Stagehand session')}
              </div>
              <button
                type="button"
                onClick={() => void props.onTakeover?.(session.id, !session.takeoverBy)}
              >
                {session.takeoverBy ? 'Return to agent' : 'Take control'}
              </button>
            </header>
            <main>
              <section>
                {props.browserFrame ? (
                  <img
                    className="live-browser-frame"
                    src={props.browserFrame}
                    alt="Live Stagehand browser session"
                  />
                ) : (
                  <div className="live-browser-state">
                    <Globe2 size={34} />
                    <span
                      className={`security-chip ${session.status === 'active' ? 'passed' : 'checking'}`}
                    >
                      {session.status}
                    </span>
                    <h2>{session.title}</h2>
                    <p>
                      {session.takeoverBy
                        ? 'Human control is active. Agent actions are paused.'
                        : 'Stagehand is operating this local browser under the run policy.'}
                    </p>
                    <small>
                      {session.classification} · {String(session.metadata.control ?? 'agent')}{' '}
                      control
                    </small>
                  </div>
                )}
              </section>
            </main>
            <form
              className="browser-action-bar"
              onSubmit={(event) => {
                event.preventDefault()
                const next = instruction.trim()
                if (!next) return
                void props.onBrowserAction?.(session.id, next).then(() => setInstruction(''))
              }}
            >
              <input
                value={instruction}
                disabled={props.busy || Boolean(session.takeoverBy)}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder={
                  session.takeoverBy
                    ? 'Return control to the agent to issue an action'
                    : 'Tell Stagehand what to do in this session…'
                }
              />
              <button
                type="submit"
                disabled={props.busy || Boolean(session.takeoverBy) || !instruction.trim()}
              >
                Run
              </button>
            </form>
          </div>
        ) : props.runMode && tab === 'browser' ? (
          <form
            className="browser-launch"
            onSubmit={(event) => {
              event.preventDefault()
              if (url) void props.onStartBrowser?.(url)
            }}
          >
            <Globe2 size={38} />
            <h2>Start a governed browser session</h2>
            <p>Stagehand launches locally and restricts navigation to the approved origin.</p>
            <label>
              Initial URL
              <input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://approved-system.example.mil"
              />
            </label>
            <button type="submit" disabled={props.busy}>
              {props.busy ? 'Launching…' : 'Launch browser'}
            </button>
          </form>
        ) : (
          <div className="tool-session-empty">
            {tab === 'browser' ? <MousePointer2 size={42} /> : <Globe2 size={42} />}
            <h2>{tabs.find(([id]) => id === tab)?.[1]} session</h2>
            <p>
              Tool sessions open here with live status, evidence, classification, and takeover
              controls.
            </p>
            <span>
              {props.runMode ? 'No active session for this run' : 'Waiting for an agent run'}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
