import { tokens } from '@papyrus/core/design'
import { useEffect, useState } from 'react'
import { Canvas } from './components/Canvas'
import { Landing } from './components/Landing'
import { Login } from './components/Login'
import { Onboarding } from './components/Onboarding'
import { ProfileBadge } from './components/ProfileBadge'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider, useTheme } from './contexts/ThemeContext'
import { ToastProvider, useToast } from './contexts/ToastContext'

type Project = { id: string; name: string; createdAt: string }

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button
      type="button"
      onClick={toggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        color: tokens.color.textMuted,
        fontSize: 14,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        borderRadius: '50%',
        transition: 'background 0.2s, color 0.2s',
      }}
    >
      {theme === 'dark' ? '\u{2600}\u{FE0F}' : '\u{1F319}'}
    </button>
  )
}

function AppContent() {
  const { user, token, loading, apiFetch } = useAuth()
  const { addToast } = useToast()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [onboarded, setOnboarded] = useState<boolean | null>(null)

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
      setProjectsLoading(false)
      setOnboarded(null)
      return
    }

    Promise.all([
      apiFetch('/api/projects').then((r) => r.json()),
      apiFetch('/api/onboarding/status').then((r) => r.json()),
    ])
      .then(([projectData, onboardingData]) => {
        setProjects(projectData as Project[])
        setOnboarded((onboardingData as { onboarded: boolean }).onboarded)
        setProjectsLoading(false)
      })
      .catch(() => setProjectsLoading(false))
  }, [token, apiFetch])

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
      <>
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', gap: 8 }}>
          <ThemeToggle />
          <ProfileBadge />
        </div>
        <Canvas
          projectId={activeProject.id}
          projectName={activeProject.name}
          onBack={() => setActiveProject(null)}
        />
      </>
    )
  }

  return (
    <>
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', gap: 8 }}>
        <ThemeToggle />
        <ProfileBadge />
      </div>
      <Landing
        projects={projects}
        loading={projectsLoading}
        onSelectProject={setActiveProject}
        onProjectCreated={(p) => {
          setProjects((prev) => [...prev, p])
          setActiveProject(p)
        }}
      />
    </>
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
