import {
  Bot,
  Boxes,
  Cable,
  ChevronLeft,
  FileSearch,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IntakePanel } from './IntakePanel'
import './workspace-shell.css'

interface WorkspaceShellProps {
  projectName: string
  onBack: () => void
  children: ReactNode
}

const NAV = [
  { label: 'Work', icon: LayoutDashboard },
  { label: 'Intake', icon: FileSearch },
  { label: 'Agents', icon: Bot },
  { label: 'Skills', icon: Sparkles },
  { label: 'Connections', icon: Cable },
  { label: 'Admin', icon: Settings },
]

export function WorkspaceShell({ projectName, onBack, children }: WorkspaceShellProps) {
  const [section, setSection] = useState('Work')
  return (
    <div className="workspace-shell">
      <aside className="workspace-rail" aria-label="Papyrus workspace navigation">
        <button className="workspace-mark" type="button" onClick={onBack} title="All projects">
          P
        </button>
        <nav>
          {NAV.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              className={section === label ? 'active' : ''}
              aria-current={section === label ? 'page' : undefined}
              onClick={() => setSection(label)}
              title={label}
            >
              <Icon size={19} strokeWidth={2.25} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace-frame">
        <header className="workspace-commandbar">
          <div className="workspace-breadcrumb">
            <button type="button" onClick={onBack}>
              <ChevronLeft size={16} /> Work
            </button>
            <strong>{projectName}</strong>
          </div>
          <div className="workspace-controls">
            <span className="classification-chip"><ShieldCheck size={14} /> CONTROLLED</span>
            <span className="runtime-chip"><Boxes size={14} /> Local runtime</span>
          </div>
        </header>
        <main className="workspace-content">{section === 'Work' ? children : section === 'Intake' ? <IntakePanel /> : <div className="workspace-section-placeholder"><h1>{section}</h1><p>Configuration for this workspace will appear here as the corresponding phase is enabled.</p></div>}</main>
      </section>
    </div>
  )
}
