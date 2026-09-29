import { defineConfig, build as viteBuild } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

function contentScriptIife() {
  return {
    name: 'content-script-iife',
    closeBundle: {
      sequential: true,
      order: 'post',
      async handler() {
        await viteBuild({
          configFile: false,
          publicDir: false,
          build: {
            emptyOutDir: false,
            outDir: path.join(root, 'dist'),
            lib: {
              entry: path.join(root, 'src/content/content-script.js'),
              name: 'NoiseCancellationContentScript',
              formats: ['iife'],
              fileName: () => 'content-script.js',
            },
            rollupOptions: {
              output: {
                inlineDynamicImports: true,
              },
            },
          },
          logLevel: 'warn',
        });

        await viteBuild({
          configFile: false,
          publicDir: false,
          build: {
            emptyOutDir: false,
            outDir: path.join(root, 'dist'),
            lib: {
              entry: path.join(root, 'src/content/page-bridge.js'),
              name: 'NoiseCancellationPageBridge',
              formats: ['iife'],
              fileName: () => 'page-bridge-main.js',
            },
            rollupOptions: {
              output: {
                inlineDynamicImports: true,
              },
            },
          },
          logLevel: 'warn',
        });

        await viteBuild({
          configFile: false,
          publicDir: false,
          build: {
            emptyOutDir: false,
            outDir: path.join(root, 'dist', 'engine'),
            lib: {
              entry: path.join(root, 'src/audio/rnnoise-worklet.js'),
              name: 'NoiseSuppressorWorkletBundle',
              formats: ['iife'],
              fileName: () => 'rnnoise-worklet.js',
            },
            rollupOptions: {
              output: {
                inlineDynamicImports: true,
              },
            },
          },
          logLevel: 'warn',
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [contentScriptIife()],
  build: {
    rollupOptions: {
      input: {
        popup: 'popup.html',
        background: 'src/background/service-worker.js',
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
