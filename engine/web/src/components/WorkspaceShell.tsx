import {
  Archive,
  BriefcaseBusiness,
  Cable,
  ChevronLeft,
  FileSearch,
  GitBranch,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { IntakePanel } from './IntakePanel'
import { WorkspaceCatalog } from './WorkspaceCatalog'
import './workspace-shell.css'

interface WorkspaceShellProps {
  projectId: string
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

export function WorkspaceShell({ projectId, projectName, onBack, children }: WorkspaceShellProps) {
  const [section, setSection] = useState('Workzone')
  const { apiFetch, loadProjectRole, projectRole, user } = useAuth()
  const [posture, setPosture] = useState<{ profile: string; authorizationStatus: string } | null>(
    null,
  )
  useEffect(() => {
    void loadProjectRole(projectId)
    void apiFetch('/api/admin/deployment-posture').then(async (response) => {
      if (!response.ok) return
      const data = (await response.json()) as {
        posture: { profile: string; authorizationStatus: string }
      }
      setPosture(data.posture)
    })
  }, [apiFetch, loadProjectRole, projectId])
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
            <span className="runtime-chip">
              {posture ? `${posture.profile} · ${posture.authorizationStatus}` : 'Loading posture…'}
            </span>
            <span className="user-role">
              {user?.displayName ?? user?.memberKey ?? 'Authenticated user'} ·{' '}
              {projectRole ?? 'loading role'}
            </span>
          </div>
        </header>
        <main className="workspace-content">
          {section === 'Workzone' ? (
            children
          ) : section === 'Staging' ? (
            <IntakePanel projectId={projectId} />
          ) : (
            <WorkspaceCatalog section={section} />
          )}
        </main>
      </section>
    </div>
  )
}
