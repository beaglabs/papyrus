import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './agent-ui-globals.js'
import { App } from './App.js'
import { ConnectorMentionLayer } from './ConnectorMentionLayer.js'
import { GovernanceExtensions } from './GovernanceExtensions.js'
import papyrusLogo from '../../../deploy/marketplace/logos/papyrus-small-48x48.png'
import './styles.css'
import './identity-branding.css'
import './classification.css'
import './portal-layout.css'
import './session-steps.css'
import './governance-extensions.css'

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/png'
favicon.href = papyrusLogo
if (!favicon.isConnected) document.head.appendChild(favicon)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <>
      <App />
      <ConnectorMentionLayer />
      <GovernanceExtensions />
    </>
  </StrictMode>,
)
