import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  // Relative asset URLs so the same build works under any server base_path.
  base: './',
  // Built straight into the Go package that embeds it.
  build: { outDir: '../internal/server/dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4096 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
      '/mcp': 'http://localhost:8080',
    },
  },
})
