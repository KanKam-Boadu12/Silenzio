import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: 'popup.html',
        background: 'src/background/service-worker.js',
        'content-script': 'src/content/content-script.js',
        'page-bridge': 'src/content/page-bridge.js',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
