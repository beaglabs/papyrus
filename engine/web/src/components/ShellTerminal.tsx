import { Terminal as TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface ShellLine {
  id: string
  type: 'command' | 'output' | 'error'
  text: string
}

export function ShellTerminal({ cwd }: { cwd?: string }) {
  const { apiFetch } = useAuth()
  const [lines, setLines] = useState<ShellLine[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [lines])

  const runCommand = useCallback(
    async (command: string) => {
      if (!command.trim()) return

      const cmdId = `cmd-${Date.now()}`
      historyRef.current.push(command)
      historyIndexRef.current = historyRef.current.length

      setLines((prev) => [...prev, { id: cmdId, type: 'command', text: command }])
      setInput('')
      setRunning(true)

      try {
        const res = await apiFetch('/api/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, cwd }),
        })
        const data = (await res.json()) as {
          stdout?: string
          stderr?: string
          exitCode?: number
          error?: string
        }

        if (data.error) {
          setLines((prev) => [
            ...prev,
            { id: `${cmdId}-err`, type: 'error', text: data.error! },
          ])
        } else {
          if (data.stdout) {
            setLines((prev) => [
              ...prev,
              { id: `${cmdId}-out`, type: 'output', text: data.stdout! },
            ])
          }
          if (data.stderr) {
            setLines((prev) => [
              ...prev,
              { id: `${cmdId}-err`, type: 'error', text: data.stderr! },
            ])
          }
          if (!data.stdout && !data.stderr && data.exitCode === 0) {
            setLines((prev) => [
              ...prev,
              { id: `${cmdId}-ok`, type: 'output', text: '(no output)' },
            ])
          }
        }
      } catch (err) {
        setLines((prev) => [
          ...prev,
          {
            id: `${cmdId}-catch`,
            type: 'error',
            text: err instanceof Error ? err.message : 'Request failed',
          },
        ])
      } finally {
        setRunning(false)
      }
    },
    [apiFetch, cwd],
  )

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !running) {
      runCommand(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = historyIndexRef.current - 1
      if (idx >= 0) {
        historyIndexRef.current = idx
        setInput(historyRef.current[idx] ?? '')
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const idx = historyIndexRef.current + 1
      if (idx < historyRef.current.length) {
        historyIndexRef.current = idx
        setInput(historyRef.current[idx] ?? '')
      } else {
        historyIndexRef.current = historyRef.current.length
        setInput('')
      }
    }
  }

  return (
    <div className="shell-terminal" onClick={() => inputRef.current?.focus()}>
      <div className="shell-output" ref={scrollRef}>
        {lines.length === 0 && (
          <div className="shell-welcome">
            <TerminalIcon size={14} /> Shell — type a command and press Enter
          </div>
        )}
        {lines.map((line) => (
          <div key={line.id} className={`shell-line ${line.type}`}>
            {line.type === 'command' && <span className="shell-prompt">$ </span>}
            <pre>{line.text}</pre>
          </div>
        ))}
        {running && <div className="shell-line output shell-running">running...</div>}
      </div>
      <div className="shell-input-row">
        <span className="shell-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          className="shell-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          placeholder={running ? 'Running...' : 'Type a command...'}
          autoFocus
        />
      </div>
    </div>
  )
}
