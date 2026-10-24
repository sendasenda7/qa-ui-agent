import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
    css: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/lib/pdf-export.js'],
      reporter: ['text', 'html', 'lcov'],
      // Seuils volontairement un peu sous la couverture actuelle : ils empêchent qu'elle baisse,
      // et on les relève au fur et à mesure que des tests sont ajoutés.
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
})
