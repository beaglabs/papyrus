import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrimaryNavigation } from './App.js'

describe('primary navigation', () => {
  it('exposes the Mastra-native runtime surfaces', () => {
    const html = renderToStaticMarkup(<PrimaryNavigation view="agent" onNavigate={() => undefined} />)
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, '').trim())
    expect(buttons).toEqual(['✦Agent', '⌘Plugins', '◷Scheduled', '⌬Workflows', '◇Governance'])
    expect(html).not.toMatch(/terrain|investigation/i)
  })
})
