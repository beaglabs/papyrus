import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
import './identity-branding.css'
import './classification.css'

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>)
