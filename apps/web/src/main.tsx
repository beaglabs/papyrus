import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './agent-ui-globals.js'
import { App } from './App.js'
import { publicConfig } from './api.js'
import papyrusLogo from '../../../deploy/marketplace/logos/papyrus-small-48x48.png'
import './styles.css'
import './profile-theme.css'
import './identity-branding.css'
import './classification.css'
import './portal-layout.css'
import './session-steps.css'

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/png'
favicon.href = papyrusLogo
if (!favicon.isConnected) document.head.appendChild(favicon)

async function applyDeploymentProfileTheme() {
  try {
    const config = await publicConfig()
    if (config.profile === 'commercial' || config.profile === 'government' || config.profile === 'disconnected') {
      document.documentElement.dataset.papyrusProfile = config.profile
    }
  } catch {
    // App owns configuration error handling. Theme discovery must never prevent rendering.
  }
}

void applyDeploymentProfileTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>)