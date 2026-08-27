import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrimaryNavigation } from './App.js'

describe('primary navigation', () => {
  it.each([false, true])('places a single New Chat action directly above Overview (canAdmin=%s)', (canAdmin) => {
    const html = renderToStaticMarkup(<PrimaryNavigation view="home" canAdmin={canAdmin} onNavigate={() => undefined} onNewSession={() => undefined} />)
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]*>/g, '').trim())
    expect(buttons).toEqual(['＋ New Chat', 'Overview', 'Sources', ...(canAdmin ? ['Administration'] : [])])
  })
})
