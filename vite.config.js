import { defineConfig } from 'vite';
import { execSync } from 'child_process';

// Pre-build plugin: joins opps into accounts at build time
function prebuildDataPlugin() {
  return {
    name: 'prebuild-data',
    buildStart() {
      console.log('[Vite] Running prebuild-data.js...');
      try {
        execSync('node scripts/prebuild-data.js', { stdio: 'inherit' });
      } catch (e) {
        console.warn('[Vite] Prebuild failed, will use runtime join:', e.message);
      }
    }
  };
}

export default defineConfig({
  // Root directory (where index.html lives)
  root: '.',

  // Dev server settings
  server: {
    open: true,
    port: 3000,
  },

  // Plugins
  plugins: [prebuildDataPlugin()],

  // Build output
  build: {
    outDir: 'dist',
    // Generate source maps for easier debugging
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'data-accounts': ['./src/data/accounts-with-opps.json'],
          'data-customers': ['./src/data/customers.json'],
        }
      }
    },
    chunkSizeWarningLimit: 600,
  },
});
