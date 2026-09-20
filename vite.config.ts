import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/` is the shadcn convention: its generated components import
  // `@/lib/utils` and each other by it. src/lib stays on relative paths —
  // the CLI bundle and the node scripts import those files directly.
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})
