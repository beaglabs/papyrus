import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3777'
const OUTPUT = '/Users/jdbohrman/papyrus/demo-video.webm'

async function getFreshToken() {
  const res = await fetch(`${API}/api/auth/local-identity`)
  const { memberKey } = await res.json()
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'local', memberKey }),
  })
  const { token } = await login.json()
  return token
}

async function main() {
  const token = await getFreshToken()
  console.log('Authenticated')

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1440,900'],
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: '/Users/jdbohrman/papyrus/', size: { width: 1440, height: 900 } },
  })

  await context.addInitScript((t) => {
    localStorage.setItem('papyrus_token', t)
  }, token)

  const page = await context.newPage()
  const wait = (ms) => page.waitForTimeout(ms)

  // Helper: get visible chat input
  async function getVisibleChatInput() {
    const inputs = page.locator('textarea.chat-input')
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i)
      if (await el.isVisible().catch(() => false)) {
        return el
      }
    }
    return inputs.first()
  }

  // Helper: approve the first proposed node via DOM
  async function approveFirstProposed() {
    await wait(1200)
    const clicked = await page.evaluate(() => {
      // Find all buttons with "Approve" text
      const buttons = Array.from(document.querySelectorAll('button'))
      const approveBtn = buttons.find(b => b.textContent?.includes('Approve'))
      if (approveBtn) {
        // Scroll node into view
        const node = approveBtn.closest('[class*="node"], [class*="react-flow__node"]')
        if (node) node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
        approveBtn.click()
        return true
      }
      return false
    })
    if (clicked) {
      console.log('   ✓ Approved via DOM')
      await wait(1500)
    } else {
      console.log('   ⚠ No approve button found')
    }
    return clicked
  }

  try {
    // ─── SCENE 1: Landing & Project Creation ───
    console.log('Scene 1: Creating project...')
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await wait(1500)

    const promptInput = page.locator('textarea.prompt-input')
    await promptInput.click()
    await wait(500)
    await page.keyboard.type('A P2P drone asset tracking platform for disconnected environments', { delay: 15 })
    await wait(800)

    const createBtn = page.locator('button.prompt-send')
    await createBtn.click()
    await wait(3000)

    // ─── SCENE 2: Canvas Overview ───
    console.log('Scene 2: Canvas overview...')
    await wait(2000)

    // ─── SCENE 3: PM Persona ───
    console.log('Scene 3: PM agent...')
    const chatInput = await getVisibleChatInput()
    await chatInput.click()
    await wait(300)
    await page.keyboard.type('Create a comprehensive PRD for this project', { delay: 15 })
    await wait(400)
    await page.keyboard.press('Enter')
    await wait(4000)
    await approveFirstProposed()

    // ─── SCENE 4: Designer Persona ───
    console.log('Scene 4: Designer agent...')
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button, div, span'))
      const designer = tabs.find(e => e.textContent?.trim() === 'DESIGN')
      if (designer) designer.click()
    })
    await wait(800)

    const chatInput2 = await getVisibleChatInput()
    await chatInput2.click()
    await wait(300)
    await page.keyboard.type('Create a wireframe for the tracking dashboard', { delay: 15 })
    await wait(400)
    await page.keyboard.press('Enter')
    await wait(4000)
    await approveFirstProposed()

    // ─── SCENE 5: Engineer Persona ───
    console.log('Scene 5: Engineer agent...')
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button, div, span'))
      const eng = tabs.find(e => e.textContent?.trim() === 'ENG')
      if (eng) eng.click()
    })
    await wait(800)

    const chatInput3 = await getVisibleChatInput()
    await chatInput3.click()
    await wait(300)
    await page.keyboard.type('Design the system architecture', { delay: 15 })
    await wait(400)
    await page.keyboard.press('Enter')
    await wait(4000)
    await approveFirstProposed()

    // ─── SCENE 6: Security Persona ───
    console.log('Scene 6: Security agent...')
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button, div, span'))
      const sec = tabs.find(e => e.textContent?.trim() === 'SEC')
      if (sec) sec.click()
    })
    await wait(800)

    const chatInput4 = await getVisibleChatInput()
    await chatInput4.click()
    await wait(300)
    await page.keyboard.type('Perform a threat model analysis', { delay: 15 })
    await wait(400)
    await page.keyboard.press('Enter')
    await wait(4000)
    await approveFirstProposed()

    // ─── SCENE 7: Final Canvas Showcase ───
    console.log('Scene 7: Final overview...')
    await wait(1000)

    // Use XYFlow fitView to see all nodes
    await page.evaluate(() => {
      // Try to trigger fitView via the canvas instance
      const canvas = document.querySelector('.react-flow__viewport')
      if (canvas) {
        canvas.dispatchEvent(new Event('fitview', { bubbles: true }))
      }
    })
    await wait(1500)

    // Zoom out with mouse wheel
    await page.mouse.move(720, 450)
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 120)
      await wait(100)
    }
    await wait(2000)

    // Smooth pan across
    await page.mouse.move(900, 450)
    await page.mouse.down()
    await page.mouse.move(300, 450, { steps: 30 })
    await page.mouse.up()
    await wait(2000)

    console.log('Demo recording complete!')
  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    await context.close()
    await browser.close()

    const fs = await import('fs')
    const files = fs.readdirSync('/Users/jdbohrman/papyrus/').filter(f => f.endsWith('.webm'))
    if (files.length > 0) {
      const latest = files.sort().reverse()[0]
      fs.renameSync(`/Users/jdbohrman/papyrus/${latest}`, OUTPUT)
      const stats = fs.statSync(OUTPUT)
      const mb = (stats.size / 1024 / 1024).toFixed(1)
      console.log(`Video saved: ${OUTPUT} (${mb} MB)`)
    }
  }
}

main().catch(console.error)
