import { useEffect, useRef, useState } from 'react'
import {
  MastraReactProvider,
  useChat,
  Message as MastraMessage,
  MessageContent as MastraMessageContent,
  MessageList as MastraMessageList,
  MessageStreaming,
} from '@mastra/react'

interface MastraChatProps {
  agentId: string
  threadId?: string
  resourceId?: string
  onCreateThread?: () => Promise<string>
  authHeaders?: Record<string, string>
}

export function MastraChat({ agentId, threadId, resourceId, onCreateThread, authHeaders }: MastraChatProps) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const providerProps: React.ComponentProps<typeof MastraReactProvider> = {
    baseUrl: origin,
    apiPrefix: '/api/agents',
    children: null,
  }
  if (authHeaders) providerProps.headers = authHeaders
  return <MastraReactProvider {...providerProps}>
    <MastraChatInner agentId={agentId} threadId={threadId} resourceId={resourceId} onCreateThread={onCreateThread} />
  </MastraReactProvider>
}

type InnerProps = { agentId: string; threadId?: string | undefined; resourceId?: string | undefined; onCreateThread?: (() => Promise<string>) | undefined }
function MastraChatInner({ agentId, threadId: initialThreadId, resourceId, onCreateThread }: InnerProps) {
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(initialThreadId)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const [followingLatest, setFollowingLatest] = useState(true)
  const [pendingApproval, setPendingApproval] = useState<{ toolCallId: string; toolName?: string } | null>(null)
  const [pendingInput, setPendingInput] = useState<{ message: string } | null>(null)

  const chatProps: Parameters<typeof useChat>[0] = { agentId }
  if (activeThreadId) chatProps.threadId = activeThreadId
  if (resourceId) chatProps.resourceId = resourceId
  const { messages, sendMessage, isRunning, isAwaitingToolApproval, approveToolCall, declineToolCall, cancelRun } = useChat(chatProps)

  useEffect(() => {
    if (!activeThreadId && onCreateThread) {
      void onCreateThread().then(setActiveThreadId)
    }
  }, [activeThreadId, onCreateThread])

  useEffect(() => {
    const suspended = messages.find((m) => Array.isArray(m.content.parts) && m.content.parts.some((p) => (p as { metadata?: { suspended?: boolean } }).metadata?.suspended))
    if (suspended) {
      const part = suspended.content.parts.find((p) => (p as { metadata?: { suspended?: boolean } }).metadata?.suspended) as { type: string; metadata?: { message?: string } } | undefined
      if (part?.metadata?.message) setPendingInput({ message: part.metadata.message })
    } else setPendingInput(null)
  }, [messages])

  useEffect(() => {
    const last = messages.at(-1)
    if (last?.role === 'assistant') {
      const approvalPart = last.content.parts.find((p) => (p as { type?: string }).type === 'tool-call-approval') as { type: string; metadata?: { toolCallId?: string; toolName?: string } } | undefined
      if (approvalPart?.metadata?.toolCallId) setPendingApproval({ toolCallId: approvalPart.metadata.toolCallId, ...(approvalPart.metadata.toolName ? { toolName: approvalPart.metadata.toolName } : {}) })
    } else setPendingApproval(null)
  }, [messages])

  useEffect(() => {
    if (!followingLatest) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, followingLatest])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text || isRunning) return
    setDraft('')
    void sendMessage({ mode: 'stream', message: text })
  }

  const submitInput = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!pendingInput) return
    const formData = new FormData(event.currentTarget)
    const response: Record<string, unknown> = {}
    for (const [key, value] of formData.entries()) response[key] = value
    void sendMessage({ mode: 'stream', message: JSON.stringify(response) })
    setPendingInput(null)
  }

  return <section className="mastra-chat">
    <div ref={listRef} className="mastra-message-list" onScroll={(event) => {
      const element = event.currentTarget
      setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 72)
    }}>
      <MastraMessageList>
        {messages.length === 0 && <div className="conversation-empty compact"><h2>What should Papyrus do?</h2><p>Describe the work to perform.</p></div>}
        {messages.map((message) => <MastraMessage key={message.id} position={message.role === 'user' ? 'right' : 'left'}>
          <MastraMessageContent isStreaming={isRunning && message.role === 'assistant'}>
            <MessageRenderer message={message} />
          </MastraMessageContent>
        </MastraMessage>)}
        {isRunning && messages.at(-1)?.role !== 'assistant' && <MastraMessage position="left"><MastraMessageContent isStreaming><MessageStreaming /></MastraMessageContent></MastraMessage>}
      </MastraMessageList>
    </div>
    {!followingLatest && <button className="jump-latest" onClick={() => { setFollowingLatest(true); listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }}>Jump to latest ↓</button>}

    {pendingApproval && <div className="tool-approval-card">
      <div><strong>Approval required</strong>{pendingApproval.toolName && <span> · {pendingApproval.toolName}</span>}</div>
      <div>
        <button onClick={() => void declineToolCall(pendingApproval.toolCallId).then(() => setPendingApproval(null))}>Decline</button>
        <button className="primary" onClick={() => void approveToolCall(pendingApproval.toolCallId).then(() => setPendingApproval(null))}>Approve</button>
      </div>
    </div>}

    {pendingInput && <form className="elicitation-card" onSubmit={submitInput}>
      <div><span>INPUT REQUIRED</span><strong>{pendingInput.message}</strong></div>
      <label>Response<textarea name="response" required /></label>
      <div><button className="primary" type="submit">Continue →</button></div>
    </form>}

    <form className="mastra-composer" onSubmit={submit}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}
        disabled={isRunning || isAwaitingToolApproval || Boolean(pendingInput)}
        placeholder={pendingInput ? 'Awaiting input…' : pendingApproval ? 'Awaiting approval…' : 'Describe the work to perform…'}
      />
      <div className="mastra-composer-actions">
        {isRunning
          ? <button type="button" className="primary danger" onClick={() => cancelRun()}>Stop</button>
          : <button type="submit" className="primary" disabled={!draft.trim()}>Send →</button>}
      </div>
    </form>
  </section>
}

function MessageRenderer({ message }: { message: { role: string; content: { parts: Array<{ type: string; text?: string; metadata?: Record<string, unknown> }> } } }) {
  return <div className="mastra-message-parts">{message.content.parts.map((part, index) => {
    if (part.type === 'text') {
      const isReasoning = part.metadata?.type === 'reasoning'
      return <div key={index} className={isReasoning ? 'mastra-reasoning' : 'mastra-text'}>{isReasoning ? <details open={false}><summary>Reasoning</summary><pre>{part.text}</pre></details> : <p>{part.text}</p>}</div>
    }
    if (part.type === 'tool-call') return <div key={index} className="mastra-tool-call">Tool call · {(part.metadata as { toolName?: string })?.toolName ?? 'tool'}</div>
    if (part.type === 'tool-result') return <div key={index} className="mastra-tool-result">Tool result · {String((part.metadata as { result?: unknown })?.result ?? '').slice(0, 256)}</div>
    return <div key={index} className="mastra-unknown">{JSON.stringify(part)}</div>
  })}</div>
}