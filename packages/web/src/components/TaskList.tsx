import { tokens } from '@papyrus/core/design'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Task {
  id: string
  projectId: string
  persona: string
  prompt: string
  status: 'running' | 'done' | 'error'
  startedAt: string
  completedAt?: string
  nodeId?: string
  nodeTitle?: string
  error?: string
}

const PERSONA_ICONS: Record<string, string> = {
  pm: '\u{1F4CB}',
  designer: '\u{1F3A8}',
  engineer: '\u{2699}\u{FE0F}',
  security: '\u{1F512}',
}

export function TaskList({ projectId }: { projectId: string }) {
  const { apiFetch } = useAuth()
  const [tasks, setTasks] = useState<Task[]>([])
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    async function fetchTasks() {
      try {
        const res = await apiFetch(`/api/tasks?projectId=${projectId}`)
        const data = (await res.json()) as Task[]
        setTasks(data)
      } catch {
        // ignore
      }
    }
    fetchTasks()
    const interval = setInterval(fetchTasks, 3000)
    return () => clearInterval(interval)
  }, [apiFetch, projectId])

  const activeTasks = tasks.filter((t) => t.status === 'running')
  const doneTasks = tasks.filter((t) => t.status !== 'running')

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          zIndex: 200,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.full,
          color: tokens.color.textMuted,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {activeTasks.length > 0 && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: tokens.color.accent,
              animation: 'pulse 1.5s infinite',
            }}
          />
        )}
        Tasks ({tasks.length})
      </button>
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        zIndex: 200,
        width: 300,
        maxHeight: '60vh',
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        boxShadow: tokens.shadow.lg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${tokens.color.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, color: tokens.color.text, flex: 1 }}>
          Tasks
        </span>
        {activeTasks.length > 0 && (
          <span style={{ fontSize: 11, color: tokens.color.accent, fontFamily: tokens.font.mono }}>
            {activeTasks.length} running
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          style={{
            background: 'none',
            border: 'none',
            color: tokens.color.textDim,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          {'\u{2715}'}
        </button>
      </div>

      {/* Task list */}
      <div style={{ overflowY: 'auto', maxHeight: '50vh' }}>
        {tasks.length === 0 && (
          <div
            style={{
              padding: '24px 14px',
              textAlign: 'center',
              color: tokens.color.textDim,
              fontSize: 12,
            }}
          >
            No tasks yet. Generate something to see it here.
          </div>
        )}

        {/* Active tasks */}
        {activeTasks.map((task) => (
          <div
            key={task.id}
            style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${tokens.color.border}`,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                border: `2px solid ${tokens.color.accent}`,
                borderTopColor: 'transparent',
                animation: 'spin 0.8s linear infinite',
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: tokens.color.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {PERSONA_ICONS[task.persona] ?? '\u{1F9E0}'} {task.prompt.slice(0, 50)}
                {task.prompt.length > 50 ? '...' : ''}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: tokens.color.accent,
                  fontFamily: tokens.font.mono,
                  marginTop: 2,
                }}
              >
                Generating...
              </div>
            </div>
          </div>
        ))}

        {/* Completed tasks */}
        {doneTasks.map((task) => (
          <div
            key={task.id}
            style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${tokens.color.border}`,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                flexShrink: 0,
                marginTop: 1,
                background:
                  task.status === 'done'
                    ? 'rgba(34,197,94,0.15)'
                    : 'rgba(239,68,68,0.15)',
                color: task.status === 'done' ? tokens.color.success : tokens.color.error,
              }}
            >
              {task.status === 'done' ? '\u{2713}' : '\u{2715}'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: tokens.color.textMuted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {PERSONA_ICONS[task.persona] ?? '\u{1F9E0}'} {task.nodeTitle ?? task.prompt.slice(0, 40)}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: tokens.color.textDim,
                  fontFamily: tokens.font.mono,
                  marginTop: 2,
                }}
              >
                {task.status === 'done'
                  ? task.completedAt
                    ? new Date(task.completedAt).toLocaleTimeString()
                    : 'Done'
                  : task.error ?? 'Failed'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
