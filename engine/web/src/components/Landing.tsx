import { tokens } from '@papyrus/core/design'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { NetworkHealth } from './NetworkHealth'

type Project = { id: string; name: string; createdAt: string }
type NetworkProject = {
  id: string
  name: string
  ownerId: string
  nodeCount: number
  updatedAt: number
}

interface LandingProps {
  projects: Project[]
  loading: boolean
  onSelectProject: (p: Project) => void
  onProjectCreated: (p: Project) => void
}

export function Landing({ projects, loading, onSelectProject, onProjectCreated }: LandingProps) {
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [networkProjects, setNetworkProjects] = useState<NetworkProject[]>([])
  const { apiFetch } = useAuth()

  // Fetch network projects
  useEffect(() => {
    async function fetchNetwork() {
      try {
        const res = await apiFetch('/api/network/projects')
        const data = (await res.json()) as NetworkProject[]
        setNetworkProjects(data.filter((p) => !projects.find((lp) => lp.id === p.id)))
      } catch {
        // ignore
      }
    }
    fetchNetwork()
    const interval = setInterval(fetchNetwork, 10000)
    return () => clearInterval(interval)
  }, [apiFetch, projects])

  async function handleSubmit() {
    if (!prompt.trim() || creating) return
    setCreating(true)
    try {
      const res = await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: prompt.trim() }),
      })
      const project = (await res.json()) as Project
      onProjectCreated(project)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="landing">
      {/* Top bar */}
      <div className="landing-topbar">
        <div className="brand">
          <img className="papyrus-logo" src="/papyrus-logo.svg" alt="" />
          <span className="name">PAPYRUS</span>
        </div>
        <div className="spacer" />
      </div>

      {/* Body */}
      <div className="landing-body">
        <h1 className="landing-greeting">What are we building?</h1>
        <p className="landing-subtitle">
          Describe your project and let AI agents build it on the canvas.
        </p>

        {/* Prompt */}
        <div className="prompt-area">
          <div className="prompt-box">
            <div className="prompt-row">
              <textarea
                className="prompt-input"
                placeholder="A secure logistics tracking platform for..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                rows={1}
              />
              <button
                type="button"
                className="prompt-send"
                onClick={handleSubmit}
                disabled={creating || !prompt.trim()}
              >
                {'\u{2191}'}
              </button>
            </div>
          </div>
        </div>

        {/* Projects */}
        {loading ? (
          <p style={{ color: tokens.color.textDim, fontSize: 13 }}>Loading projects...</p>
        ) : (
          <div className="project-sections">
            {/* Empty state */}
            {projects.length === 0 && networkProjects.length === 0 && (
              <div className="landing-empty">
                <div className="icon">{'\u{1F4C4}'}</div>
                <div className="title">No projects yet</div>
                <div className="desc">Type a prompt above to create your first project.</div>
              </div>
            )}

            {/* Local projects */}
            {projects.length > 0 && (
              <div className="project-section">
                <h2 className="project-section-title">Your Projects</h2>
                <div className="project-grid">
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="project-card"
                      onClick={() => onSelectProject(p)}
                    >
                      <span className="title">{p.name}</span>
                      <span className="meta">{new Date(p.createdAt).toLocaleDateString()}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Network projects */}
            {networkProjects.length > 0 && (
              <div className="project-section">
                <h2 className="project-section-title">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={tokens.color.accent}
                    strokeWidth="2"
                  >
                    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                    <circle cx="12" cy="20" r="1" />
                  </svg>
                  On the Network
                </h2>
                <div className="project-grid">
                  {networkProjects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="project-card"
                      onClick={() =>
                        onSelectProject({
                          id: p.id,
                          name: p.name,
                          createdAt: new Date(p.updatedAt).toISOString(),
                        })
                      }
                    >
                      <span className="title">{p.name}</span>
                      <span className="meta">{p.nodeCount} nodes</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <NetworkHealth />
    </div>
  )
}
