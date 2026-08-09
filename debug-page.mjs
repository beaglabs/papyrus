import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const API = 'http://localhost:3777'

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
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1440,900'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  
  await context.addInitScript((t) => {
    localStorage.setItem('papyrus_token', t)
  }, token)
  
  const page = await context.newPage()
  
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  
  // Extract page text to understand what's visible
  const bodyText = await page.evaluate(() => document.body.innerText)
  console.log('=== PAGE TEXT ===')
  console.log(bodyText.slice(0, 3000))
  console.log('=== END ===')
  
  // Get all buttons
  const buttons = await page.evaluate(() => 
    Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
  )
  console.log('\n=== BUTTONS ===')
  console.log(JSON.stringify(buttons, null, 2))
  
  // Get all inputs
  const inputs = await page.evaluate(() => 
    Array.from(document.querySelectorAll('textarea, [contenteditable], input')).map(el => ({
      tag: el.tagName,
      placeholder: el.placeholder || '',
      contentEditable: el.contentEditable,
      className: el.className?.slice(0, 80) || '',
    }))
  )
  console.log('\n=== INPUTS ===')
  console.log(JSON.stringify(inputs, null, 2))
  
  await browser.close()
}

main().catch(console.error)
