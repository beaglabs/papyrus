import {
  Archive,
  Bell,
  BriefcaseBusiness,
  Cable,
  ChevronLeft,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { IntakePanel } from './IntakePanel'
import { WorkspaceCatalog } from './WorkspaceCatalog'
import './workspace-shell.css'

interface WorkspaceShellProps {
  projectName: string
  onBack: () => void
  children: ReactNode
}

const NAV = [
  { label: 'Workzone', icon: LayoutDashboard },
  { label: 'Staging', icon: FileSearch },
  { label: 'Workflows', icon: GitBranch },
  { label: 'People', icon: Users },
  { label: 'Budget & Contracts', icon: BriefcaseBusiness },
  { label: 'Connections', icon: Cable },
  { label: 'Records', icon: Archive },
  { label: 'Administration', icon: Settings },
]

export function WorkspaceShell({ projectName, onBack, children }: WorkspaceShellProps) {
  const [section, setSection] = useState('Workzone')
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
              <ChevronLeft size={16} /> Projects
            </button>
            <strong title={projectName}>{projectName}</strong>
          </div>
          <div className="workspace-controls">
            <span className="classification-chip">
              <ShieldCheck size={14} /> CUI WORKSPACE
            </span>
            <span className="runtime-chip">IL5 READY · LOCAL :8000</span>
            <button className="command-icon" type="button" aria-label="Audit log">
              <ScrollText size={16} />
            </button>
            <button className="command-icon" type="button" aria-label="Notifications">
              <Bell size={16} />
            </button>
            <span className="user-role">Local User · Operator</span>
          </div>
        </header>
        <main className="workspace-content">
          {section === 'Workzone' ? (
            children
          ) : section === 'Staging' ? (
            <IntakePanel />
          ) : (
            <WorkspaceCatalog section={section} />
          )}
        </main>
      </section>
    </div>
  )
}
