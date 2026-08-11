import {
  Check,
  CircleX,
  Code2,
  FileCode2,
  Paperclip,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import type { BuildValidation, Generation, GeneratedFile } from './DevEnvironment'

interface ChatPanelProps {
  projectId: string
  projectBrief: string
  generations: Generation[]
  activeGeneration: Generation | null
  onGenerationComplete: (
    prompt: string,
    files: GeneratedFile[],
    template?: string,
  ) => Promise<string>
  onSelectGeneration: (gen: Generation) => void
  onLoadingChange?: (loading: boolean) => void
  buildValidation: BuildValidation | null
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  generationId?: string
  error?: boolean
}

const QUICK_ACTIONS = [
  {
    id: 'app',
    label: 'Full App',
    icon: ' ',
    prompt: 'Build a complete application with all features.',
  },
  { id: 'component', label: 'Component', icon: ' ', prompt: 'Create a reusable UI component.' },
  { id: 'page', label: 'Page', icon: ' ', prompt: 'Build a full page with layout and navigation.' },
  {
    id: 'api',
    label: 'API + UI',
    icon: '⚡',
    prompt: 'Create an API backend with a frontend that consumes it.',
  },
]

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
      '<code style="background:#f0f0f0;border:1px solid #d0d0d0;padding:1px 4px;border-radius:4px;font-family:var(--font-mono);font-size:11px;">$1</code>',
    )
    .replace(/^- (.*$)/gm, '<div style="padding-left:16px;text-indent:-12px;">  $1</div>')
    .replace(/\n/g, '<br />')
}

export function ChatPanel({
  projectId,
  projectBrief,
  generations,
  activeGeneration,
  onGenerationComplete,
  onSelectGeneration,
  onLoadingChange,
  buildValidation,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: "I'm your **Papyrus engineer**. Describe what you want to build and I'll generate the code.\n\nI can create full applications, components, pages, or API backends. Just tell me what you need.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [attachments, setAttachments] = useState<
    Array<{ name: string; mimeType: string; content: string }>
  >([])
  const [skills, setSkills] = useState<Array<{ name: string; content: string }>>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const chatHistoryRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const pendingCompletionRef = useRef<{
    assistantMessageId: string
    generationId: string
    responseText: string
  } | null>(null)
  const repairAttemptsRef = useRef<Record<string, number>>({})
  const { apiFetch } = useAuth()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load existing conversation, auto-generate if brief exists
  useEffect(() => {
    let cancelled = false
    void apiFetch(`/api/chat?projectId=${encodeURIComponent(projectId)}&persona=orchestrator`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load conversation')
        return response.json() as Promise<{
          messages: Array<{
            id: string
            role: 'user' | 'assistant'
            content: string
            nodes: unknown[]
          }>
        }>
      })
      .then(({ messages: stored }) => {
        if (cancelled) return
        if (stored.length > 0) {
          chatHistoryRef.current = stored.map((message) => ({
            role: message.role,
            content: message.content,
          }))
          setMessages(
            stored.map((message) => ({
              id: message.id,
              role: message.role === 'assistant' ? 'assistant' : 'user',
              text: message.content,
            })),
          )
        } else if (projectBrief.trim()) {
          // No existing conversation but brief exists — auto-generate
          const autoPrompt = `Based on this project brief, generate the initial code:\n\n${projectBrief}`
          void sendToAgent(autoPrompt)
        }
      })
      .catch((error) => console.error('Chat history load failed:', error))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFetch, projectId, projectBrief])

  const sendToAgent = useCallback(
    async (prompt: string, options: { repairMessageId?: string } = {}) => {
      setLoading(true)
      onLoadingChange?.(true)

      if (!options.repairMessageId) {
        const userMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          text: prompt,
        }
        setMessages((prev) => [...prev, userMsg])
      }
      chatHistoryRef.current.push({ role: 'user', content: prompt })
      setInput('')

      const assistantMsgId = options.repairMessageId ?? `msg-${Date.now() + 1}`
      if (options.repairMessageId) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId ? { ...msg, text: 'Fixing the compilation error…' } : msg,
          ),
        )
      } else {
        setMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', text: '' }])
      }

      try {
        const contextMessages = chatHistoryRef.current.map((message, index, history) =>
          index === history.length - 1 && message.role === 'user' && projectBrief
            ? {
                ...message,
                content: `${message.content}\n\n--- Project Brief ---\n${projectBrief}`,
              }
            : message,
        )

        const res = await apiFetch('/api/agent/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            messages: contextMessages,
            projectId,
            attachments,
            skills,
            existingFiles: activeGeneration?.files.map((f) => ({
              path: f.path,
              content: f.content,
              language: f.language,
            })),
          }),
        })

        if (!res.ok) {
          const err = (await res.json()) as { error?: string }
          throw new Error(err.error ?? 'Agent request failed')
        }

        const reader = res.body?.getReader()
        if (!reader) throw new Error('No response stream')

        const decoder = new TextDecoder()
        let buffer = ''
        let fullText = ''
        let genId: string | undefined

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          let eventType = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7)
            } else if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>
              if (eventType === 'token') {
                fullText += data.text
                setMessages((prev) =>
                  prev.map((msg) => (msg.id === assistantMsgId ? { ...msg, text: fullText } : msg)),
                )
              } else if (eventType === 'status') {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, text: String(data.message ?? 'Working…') }
                      : msg,
                  ),
                )
              } else if (eventType === 'nodes') {
                const nodes = data.nodes as Array<{
                  id: string
                  artifact?: {
                    files?: Array<{ path: string; content: string; language?: string }>
                    renderer?: { options?: { template?: string } }
                  }
                }>
                const codeNode = nodes.find((n) => n.artifact?.files && n.artifact.files.length > 0)
                if (codeNode?.artifact?.files) {
                  genId = codeNode.id
                  genId = await onGenerationComplete(
                    prompt,
                    codeNode.artifact.files.map((f) => ({
                      path: f.path,
                      content: f.content,
                      language: f.language,
                    })),
                    codeNode.artifact.renderer?.options?.template,
                  )
                }
              } else if (eventType === 'error') {
                throw new Error(String(data.message ?? 'Agent error'))
              }
            }
          }
        }

        if (genId) {
          pendingCompletionRef.current = {
            assistantMessageId: assistantMsgId,
            generationId: genId,
            responseText: fullText,
          }
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    text: 'Compiling and validating the generated project…',
                    generationId: genId,
                  }
                : msg,
            ),
          )
        } else {
          chatHistoryRef.current.push({ role: 'assistant', content: fullText })
        }
        setAttachments([])
        setSkills([])
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Something went wrong'
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  text: `Sorry, I encountered an error: **${errorMsg}**.\n\nCheck the daemon's LLM provider configuration.`,
                  error: true,
                }
              : msg,
          ),
        )
      } finally {
        setLoading(false)
        onLoadingChange?.(false)
      }
    },
    [
      activeGeneration,
      apiFetch,
      attachments,
      onGenerationComplete,
      onLoadingChange,
      projectBrief,
      projectId,
      skills,
    ],
  )

  useEffect(() => {
    const pending = pendingCompletionRef.current
    if (!pending || !buildValidation || buildValidation.generationId !== pending.generationId)
      return

    if (buildValidation.status === 'ready') {
      chatHistoryRef.current.push({ role: 'assistant', content: pending.responseText })
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === pending.assistantMessageId
            ? { ...msg, text: pending.responseText || 'Created a compiled application for review.' }
            : msg,
        ),
      )
      pendingCompletionRef.current = null
      return
    }

    if (buildValidation.status === 'failed' && !loading) {
      const attempts = repairAttemptsRef.current[pending.assistantMessageId] ?? 0
      if (attempts >= 3) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === pending.assistantMessageId
              ? {
                  ...msg,
                  text: `The project still does not compile after 3 repair attempts: **${buildValidation.error ?? 'Unknown compiler error'}**`,
                  error: true,
                }
              : msg,
          ),
        )
        pendingCompletionRef.current = null
        return
      }
      repairAttemptsRef.current[pending.assistantMessageId] = attempts + 1
      void sendToAgent(
        `The generated project failed to compile. Fix the project and return the complete updated application. Do not declare it complete until every import resolves and it compiles.\n\nCompiler error:\n${buildValidation.error ?? 'Unknown compiler error'}`,
        { repairMessageId: pending.assistantMessageId },
      )
    }
  }, [buildValidation, loading, sendToAgent])

  function handleSend() {
    if (!input.trim() || loading) return
    sendToAgent(input.trim())
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      const text = await file.text()
      const content = text.slice(0, 100_000)
      if (/^(skill\.md|.+\.skill\.md)$/i.test(file.name)) {
        setSkills((prev) => [...prev, { name: file.name, content }])
      } else {
        setAttachments((prev) => [
          ...prev,
          { name: file.name, mimeType: file.type || 'text/plain', content },
        ])
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="chat-panel">
      {/* Messages */}
      <div className="chat-messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-msg ${msg.role}`}>
            <div className="chat-msg-avatar">
              {msg.role === 'assistant' ? <Code2 size={14} /> : 'U'}
            </div>
            <div className="chat-msg-content">
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
              {msg.generationId && (
                <button
                  type="button"
                  className="chat-view-code-btn"
                  onClick={() => {
                    const gen = generations.find((g) => g.id === msg.generationId)
                    if (gen) onSelectGeneration(gen)
                  }}
                >
                  <FileCode2 size={12} /> View code
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-msg assistant">
            <div className="chat-msg-avatar">
              <Code2 size={14} />
            </div>
            <div className="chat-msg-content">
              <span className="typing-indicator">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick actions */}
      {messages.length <= 1 && (
        <div className="chat-quick-actions">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              className="chat-quick-action"
              onClick={() => sendToAgent(action.prompt)}
              disabled={loading}
            >
              <span className="chat-quick-action-icon">{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="chat-attachments">
          {attachments.map((attachment, i) => (
            <span key={`${attachment.name}-${i}`} className="chat-attachment-chip">
              <Paperclip size={11} /> {attachment.name}
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {skills.length > 0 && (
        <div className="chat-attachments">
          {skills.map((skill, i) => (
            <span key={`${skill.name}-${i}`} className="chat-attachment-chip">
              <Sparkles size={11} /> {skill.name}
              <button
                type="button"
                onClick={() => setSkills((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="chat-input-area">
        <div className="chat-input-wrapper">
          <button
            type="button"
            className="chat-attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
          >
            <Paperclip size={16} />
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
            ref={composerRef}
            className="chat-input"
            placeholder={loading ? 'Working...' : 'Describe what to build...'}
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
            className="chat-send-btn"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            aria-label="Send"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
