import { defineConfig } from 'vite';

export default defineConfig({
  // Root directory (where index.html lives)
  root: '.',

  // Dev server settings
  server: {
    open: true,
    port: 3000,
  },

  // Build output
  build: {
    outDir: 'dist',
    // Generate source maps for easier debugging
    sourcemap: true,
  },
});
