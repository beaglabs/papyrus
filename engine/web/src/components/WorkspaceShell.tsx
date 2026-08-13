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
import type { ReactNode } from 'react'
import './workspace-shell.css'

interface WorkspaceShellProps {
  projectName: string
  onBack: () => void
  children: ReactNode
}

const NAV = [
  { label: 'Work', icon: LayoutDashboard, active: true },
  { label: 'Intake', icon: FileSearch },
  { label: 'Agents', icon: Bot },
  { label: 'Skills', icon: Sparkles },
  { label: 'Connections', icon: Cable },
  { label: 'Admin', icon: Settings },
]

export function WorkspaceShell({ projectName, onBack, children }: WorkspaceShellProps) {
  return (
    <div className="workspace-shell">
      <aside className="workspace-rail" aria-label="Papyrus workspace navigation">
        <button className="workspace-mark" type="button" onClick={onBack} title="All projects">
          P
        </button>
        <nav>
          {NAV.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
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
        <main className="workspace-content">{children}</main>
      </section>
    </div>
  )
}
