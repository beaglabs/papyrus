import { tokens } from '@papyrus/core/design'
import { useCallback, useEffect, useState } from 'react'
import { CapeWorkzone } from './components/CapeWorkzone'
import { Login } from './components/Login'
import { Onboarding } from './components/Onboarding'
import { WorkspaceShell } from './components/WorkspaceShell'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ToastProvider, useToast } from './contexts/ToastContext'

type Project = { id: string; name: string; createdAt: string }

function AppContent() {
  const { token, loading, apiFetch } = useAuth()
  const { addToast } = useToast()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [workspaceBootstrapping, setWorkspaceBootstrapping] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')

  const activateProject = useCallback((project: Project) => {
    localStorage.setItem('papyrus.activeProjectId', project.id)
    setActiveProject(project)
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { message: string }
      addToast(detail.message, 'warning')
    }
    window.addEventListener('papyrus:auth-expired', handler)
    return () => window.removeEventListener('papyrus:auth-expired', handler)
  }, [addToast])

  useEffect(() => {
    if (!token) {
      setProjects([])
      setActiveProject(null)
      setProjectsLoading(false)
      setOnboarded(null)
      setWorkspaceBootstrapping(false)
      setWorkspaceError('')
      return
    }

    Promise.all([apiFetch('/api/projects'), apiFetch('/api/onboarding/status')])
      .then(async ([projectsResponse, onboardingResponse]) => {
        if (!projectsResponse.ok || !onboardingResponse.ok)
          throw new Error('Unable to load the organization workspace')
        const projectData = (await projectsResponse.json()) as Project[]
        const onboardingData = (await onboardingResponse.json()) as { onboarded: boolean }
        setProjects(projectData)
        setOnboarded(onboardingData.onboarded)
        setProjectsLoading(false)
      })
      .catch((error: unknown) => {
        setProjectsLoading(false)
        setWorkspaceError(
          error instanceof Error ? error.message : 'Unable to load the organization workspace',
        )
      })
  }, [token, apiFetch])

  useEffect(() => {
    if (
      !token ||
      onboarded !== true ||
      projectsLoading ||
      activeProject ||
      workspaceBootstrapping ||
      workspaceError
    )
      return

    const previousProjectId = localStorage.getItem('papyrus.activeProjectId')
    const previousProject = projects.find((project) => project.id === previousProjectId)
    const availableProject = previousProject ?? projects[0]
    if (availableProject) {
      activateProject(availableProject)
      return
    }

    setWorkspaceBootstrapping(true)
    void apiFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Operations Workspace' }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const data = (await response.json()) as { error?: string }
          throw new Error(data.error ?? 'Unable to create the organization workspace')
        }
        const project = (await response.json()) as Project
        setProjects([project])
        activateProject(project)
      })
      .catch((error: unknown) => {
        setWorkspaceError(
          error instanceof Error ? error.message : 'Unable to open the organization workspace',
        )
      })
      .finally(() => setWorkspaceBootstrapping(false))
  }, [
    activeProject,
    activateProject,
    apiFetch,
    onboarded,
    projects,
    projectsLoading,
    token,
    workspaceBootstrapping,
    workspaceError,
  ])

  if (!loading && !token) {
    return <Login />
  }

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: tokens.color.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.color.textDim,
        }}
      >
        Loading...
      </div>
    )
  }

  // Show onboarding if not completed
  if (onboarded === false) {
    return <Onboarding onComplete={() => setOnboarded(true)} />
  }

  if (activeProject) {
    return (
      <WorkspaceShell
        projectId={activeProject.id}
        projects={projects}
        onProjectChange={activateProject}
      >
        <CapeWorkzone projectId={activeProject.id} projectName={activeProject.name} />
      </WorkspaceShell>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        display: 'grid',
        placeItems: 'center',
        color: tokens.color.textDim,
        padding: 32,
      }}
    >
      {workspaceError ? (
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <strong style={{ display: 'block', color: tokens.color.text, marginBottom: 8 }}>
            Papyrus could not open a workspace
          </strong>
          <span>{workspaceError}</span>
          <button
            type="button"
            style={{ display: 'block', margin: '20px auto 0' }}
            onClick={() => setWorkspaceError('')}
          >
            Retry
          </button>
        </div>
      ) : (
        'Opening your workspace…'
      )}
    </div>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
