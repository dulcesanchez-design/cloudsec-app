import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Las versiones nuevas se descargan solas y se activan sin pedir confirmación.
      // El registro se hace en src/main.jsx con virtual:pwa-register.
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Cloud Security',
        short_name: 'CloudSec',
        description: 'Aprende ciberseguridad y seguridad en la nube con lecciones cortas.',
        lang: 'es',
        dir: 'ltr',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        id: '/',
        theme_color: '#0f1117',
        background_color: '#0f1117',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Guarda toda la app (JS con los módulos de contenido, CSS, HTML, íconos) para uso sin conexión.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // Con injectRegister: false el plugin no los activa solo: sin esto, la versión nueva
        // quedaría «en espera» hasta cerrar todas las pestañas.
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
})
