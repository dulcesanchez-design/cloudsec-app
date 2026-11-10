import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

// Service worker (modo autoUpdate): al abrir la app comprueba si hay una versión nueva;
// si la hay, la descarga, la activa y recarga la página para aplicarla.
// El progreso vive en localStorage, que este registro no toca.
registerSW({ immediate: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
