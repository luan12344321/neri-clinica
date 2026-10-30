import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // o app avisa da versão nova (StatusPage.tsx) em vez de recarregar no meio de um cadastro
      includeAssets: ['apple-touch-icon.png', 'neri-logo.png', 'neri-n.png'],
      manifest: {
        id: '/',
        name: 'Clínica — Gestão',
        short_name: 'Clínica',
        description: 'Agenda, financeiro, estoque e a assistente Julia da sua clínica.',
        lang: 'pt-BR',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['business', 'medical', 'productivity'],
        background_color: '#0d0d0d',
        theme_color: '#163b2d',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Dados da API nunca são cacheados pelo service worker (financeiro/saúde).
      workbox: { navigateFallbackDenylist: [/^\/api/] },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
