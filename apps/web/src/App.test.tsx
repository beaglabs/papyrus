import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrimaryNavigation } from './App.js'

describe('primary navigation', () => {
  it('contains only cyber-twin product surfaces and no chat or session entrypoint', () => {
    const html = renderToStaticMarkup(<PrimaryNavigation view="posture" onNavigate={() => undefined} />)
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, '').trim())
    expect(buttons).toEqual(['◫Posture', '⌘Cyber terrain', '◎Investigations', '↗Integrations', '◇Governance'])
    expect(html).not.toMatch(/chat|session/i)
  })
})
