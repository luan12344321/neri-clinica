import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Clínica — Gestão',
        short_name: 'Clínica',
        lang: 'pt-BR',
        display: 'standalone',
        background_color: '#f6f4ef',
        theme_color: '#0f5c57',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
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
