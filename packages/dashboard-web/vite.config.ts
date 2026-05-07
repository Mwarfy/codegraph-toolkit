import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4242',
      '/ws': { target: 'ws://127.0.0.1:4242', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
