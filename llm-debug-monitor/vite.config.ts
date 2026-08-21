import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // MCP server icons are served by Electron's API server on port 9876
      '/api/mcp': {
        target: 'http://localhost:9876',
        changeOrigin: true,
      },
      // All other API requests go to the debug monitor backend
      '/api': {
        target: 'http://localhost:8879',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8879',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
