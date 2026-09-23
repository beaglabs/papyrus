import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { hydrateEntraAppBranding } from './entra-branding.js'
import './styles.css'
import './identity-branding.css'
import './entra-identity.css'
import './classification.css'

void hydrateEntraAppBranding()

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>)
