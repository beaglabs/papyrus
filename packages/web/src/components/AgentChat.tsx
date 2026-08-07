import { tokens } from '@papyrus/core/design'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Persona {
  id: string
  name: string
  role: string
  color: string
  icon: string
  description: string
}

interface ChatMessage {
  id: string
  role: 'agent' | 'user'
  text: string
  nodeCreated?: boolean
}

interface AgentChatProps {
  persona: Persona
  personas: Persona[]
  onPersonaChange: (p: Persona) => void
  projectId: string
  peerId: string
}

const SEED_MESSAGES: Record<string, ChatMessage[]> = {
  pm: [
    {
      id: 'seed-1',
      role: 'agent',
      text: "I'm your **Product Manager**. I'll help define requirements, create user stories, and shape the product vision.\n\nWhat are we building?",
    },
  ],
  designer: [
    {
      id: 'seed-1',
      role: 'agent',
      text: "I'm your **Designer**. I'll create wireframes, design systems, and UI specs.\n\nTell me about the experience you want to create.",
    },
  ],
  engineer: [
    {
      id: 'seed-1',
      role: 'agent',
      text: "I'm your **Engineer**. I'll design architecture, define APIs, and plan the implementation.\n\nWhat's the technical challenge?",
    },
  ],
  security: [
    {
      id: 'seed-1',
      role: 'agent',
      text: "I'm your **Security Reviewer**. I'll identify threats, review compliance, and ensure our posture is solid.\n\nWhat's the threat surface?",
    },
  ],
}

interface TemplateBtn {
  id: string
  label: string
  icon: string
  prompt: string
}

const TEMPLATES: Record<string, TemplateBtn[]> = {
  pm: [
    {
      id: 'prd',
      label: 'PRD',
      icon: '\u{1F4CB}',
      prompt: 'Create a comprehensive Product Requirements Document for this project.',
    },
    {
      id: 'stories',
      label: 'User Stories',
      icon: '\u{1F4DD}',
      prompt: 'Draft user stories with acceptance criteria.',
    },
    {
      id: 'metrics',
      label: 'Success Metrics',
      icon: '\u{1F3AF}',
      prompt: 'Define success metrics and KPIs for this project.',
    },
  ],
  designer: [
    {
      id: 'wireframe',
      label: 'Wireframe',
      icon: '\u{1F3A8}',
      prompt: 'Create a wireframe for the main dashboard interface.',
    },
    {
      id: 'design-sys',
      label: 'Design System',
      icon: '\u{1F4A1}',
      prompt: 'Define a design system with colors, typography, and spacing.',
    },
    {
      id: 'journey',
      label: 'User Journey',
      icon: '\u{1F9ED}',
      prompt: 'Map the end-to-end user journey.',
    },
  ],
  engineer: [
    {
      id: 'arch',
      label: 'Architecture',
      icon: '\u{1F3D7}\u{FE0F}',
      prompt: 'Design the system architecture for this project.',
    },
    {
      id: 'api',
      label: 'API Spec',
      icon: '\u{1F527}',
      prompt: 'Design a REST API specification with all endpoints.',
    },
    {
      id: 'data',
      label: 'Data Model',
      icon: '\u{1F4BE}',
      prompt: 'Plan the data model and database schema.',
    },
  ],
  security: [
    {
      id: 'stride',
      label: 'Threat Model',
      icon: '\u{1F6E1}\u{FE0F}',
      prompt: 'Perform a STRIDE threat model analysis.',
    },
    {
      id: 'compliance',
      label: 'Compliance',
      icon: '\u{2705}',
      prompt: 'Check compliance requirements (NIST, FedRAMP).',
    },
    {
      id: 'access',
      label: 'Access Control',
      icon: '\u{1F510}',
      prompt: 'Review access controls and authentication.',
    },
  ],
}

/** Simple markdown-to-HTML renderer for agent messages. */
function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(
      /^### (.*$)/gm,
      '<h3 style="font-size:13px;font-weight:700;color:#0a0a0a;margin:8px 0 4px;">$1</h3>',
    )
    .replace(
      /^## (.*$)/gm,
      '<h2 style="font-size:14px;font-weight:800;color:#0a0a0a;margin:10px 0 6px;">$1</h2>',
    )
    .replace(
      /^# (.*$)/gm,
      '<h1 style="font-size:16px;font-weight:800;color:#0a0a0a;margin:12px 0 8px;">$1</h1>',
    )
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(
      /`(.*?)`/g,
      '<code style="background:#ffe1d2;border:1px solid #111;padding:1px 4px;border-radius:4px;font-family:monospace;font-size:11px;">$1</code>',
    )
    .replace(/^- (.*$)/gm, '<div style="padding-left:16px;text-indent:-12px;">\u{2022} $1</div>')
    .replace(/^\d+\. (.*$)/gm, '<div style="padding-left:20px;">$1</div>')
    .replace(/\n/g, '<br />')
}

export function AgentChat({ persona, personas, onPersonaChange, projectId }: AgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => SEED_MESSAGES[persona.id] ?? [])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [attachments, setAttachments] = useState<string[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const { apiFetch } = useAuth()

  useEffect(() => {
    void messages.length
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendToAgent(text: string) {
    setLoading(true)

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      text,
    }
    setMessages((prev) => [...prev, userMsg])
    chatHistoryRef.current.push({ role: 'user', content: text })
    setInput('')

    try {
      const res = await apiFetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persona: persona.id,
          messages: chatHistoryRef.current,
          projectId,
          attachments,
        }),
      })

      if (!res.ok) {
        const err = (await res.json()) as { error?: string }
        throw new Error(err.error ?? 'Agent request failed')
      }

      const data = (await res.json()) as { text: string; node?: { type: string; title: string } }

      chatHistoryRef.current.push({ role: 'assistant', content: data.text })

      const agentMsg: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        role: 'agent',
        text: data.text,
        nodeCreated: !!data.node,
      }
      setMessages((prev) => [...prev, agentMsg])
      setAttachments([])
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Something went wrong'
      const errMsg: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        role: 'agent',
        text: `Sorry, I encountered an error: **${errorMsg}**.\n\nMake sure \`OPENROUTER_API_KEY\` is set in your environment.`,
      }
      setMessages((prev) => [...prev, errMsg])
    } finally {
      setLoading(false)
    }
  }

  function handleSend() {
    if (!input.trim() || loading) return
    sendToAgent(input.trim())
  }

  function handleTemplate(template: TemplateBtn) {
    sendToAgent(template.prompt)
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files) return

    for (const file of Array.from(files)) {
      const text = await file.text()
      const attachment = `### ${file.name}\n\`\`\`\n${text.slice(0, 5000)}\n\`\`\``
      setAttachments((prev) => [...prev, attachment])
    }

    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="chat-panel">
      {/* Persona tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${tokens.color.border}` }}>
        {personas.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPersonaChange(p)}
            style={{
              flex: 1,
              padding: '10px 8px',
              background: p.id === persona.id ? tokens.color.surfaceHover : 'transparent',
              border: 'none',
              borderBottom: p.id === persona.id ? `2px solid ${p.color}` : '2px solid transparent',
              color: p.id === persona.id ? tokens.color.text : tokens.color.textDim,
              cursor: 'pointer',
              fontFamily: tokens.font.body,
              fontSize: 11,
              fontWeight: 600,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ fontSize: 16 }}>{p.icon}</span>
            <span>{p.role}</span>
          </button>
        ))}
      </div>

      {/* Header */}
      <div className="chat-header">
        <span className="persona-dot" style={{ background: persona.color }} />
        <span className="persona-name">{persona.name}</span>
        <span className="persona-role">{persona.role}</span>
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg ${msg.role}`}>
            <div
              className="avatar"
              style={msg.role === 'agent' ? { background: persona.color } : undefined}
            >
              {msg.role === 'agent' ? persona.icon : 'U'}
            </div>
            <div className="bubble">
              <div
                // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown escapes the source string before adding limited markup.
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(msg.text),
                }}
              />
              {msg.nodeCreated && (
                <div
                  style={{
                    marginTop: 8,
                    padding: '6px 10px',
                    background: `${persona.color}22`,
                    border: `1px solid ${persona.color}44`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 11,
                    color: persona.color,
                    fontFamily: tokens.font.mono,
                  }}
                >
                  {'\u{2713}'} Artifact added to canvas
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className={'chat-msg agent'}>
            <div className="avatar" style={{ background: persona.color }}>
              {persona.icon}
            </div>
            <div className="bubble" style={{ color: tokens.color.textDim }}>
              <span className="typing-dots">Thinking...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '6px 16px',
            flexWrap: 'wrap',
            borderTop: `1px solid ${tokens.color.border}`,
          }}
        >
          {attachments.map((attachment, i) => (
            <span
              key={attachment}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                background: tokens.color.surfaceHover,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.full,
                fontSize: 10,
                color: tokens.color.textMuted,
              }}
            >
              {'\u{1F4CE}'} Attachment {i + 1}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                style={{
                  background: 'none',
                  border: 'none',
                  color: tokens.color.textDim,
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                {'\u{2715}'}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Template buttons */}
      <div className="skill-bar">
        {(TEMPLATES[persona.id] ?? []).map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            className="skill-btn"
            onClick={() => handleTemplate(tpl)}
            disabled={loading}
          >
            <span className="icon">{tpl.icon}</span>
            {tpl.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="chat-input-area">
        <div className="chat-input-wrapper">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.color.textDim,
              cursor: 'pointer',
              fontSize: 16,
              padding: 0,
              flexShrink: 0,
            }}
            title="Attach file"
          >
            {'\u{1F4CE}'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileUpload}
            style={{ display: 'none' }}
            accept=".txt,.md,.json,.csv,.yaml,.yml,.xml,.html,.css,.js,.ts,.py,.go,.rs"
          />
          <textarea
            className="chat-input"
            placeholder={loading ? 'Agent is thinking...' : `Ask the ${persona.name}...`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={1}
            disabled={loading}
          />
          <button
            type="button"
            className="chat-send"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            {'\u{2191}'}
          </button>
        </div>
      </div>
    </div>
  )
}
