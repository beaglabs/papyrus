import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './worker-policy.js'
import { App } from './App.js'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>)
