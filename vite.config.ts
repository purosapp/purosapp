import { defineConfig, loadEnv } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const lastFmEnv = loadEnv(mode, __dirname, 'LASTFM_')

  return {
    // Do not implicitly expose arbitrary VITE_* values to the renderer.
    envPrefix: 'PUROS_PUBLIC_',
    optimizeDeps: {
      include: ['butterchurn', 'butterchurn-presets', 'milkdrop-preset-utils'],
    },
    plugins: [
      react(),
      tailwindcss(),
      electron({
        main: {
          entry: {
            main: 'electron/main.ts',
            'provider-runtime': 'electron/provider-runtime.ts',
            'visualizer-converter': 'electron/visualizer-converter.ts',
          },
          vite: {
            resolve: {
              // Providers import the API by package name; bundle the cloned SDK source (repos.json).
              alias: [{ find: /^puros-provider-sdk$/, replacement: path.join(__dirname, 'provider-sdk', 'src', 'index.ts') }],
            },
            // Last.fm is a core feature, independent of the selected playback
            // providers. Embed only its app credentials in the main process.
            define: {
              __PUROS_LASTFM_CREDENTIALS__: JSON.stringify({
                apiKey: lastFmEnv.LASTFM_API_KEY?.trim() ?? '',
                apiSecret: lastFmEnv.LASTFM_API_SECRET?.trim() ?? '',
              }),
            },
            build: {
              rollupOptions: {
                external: ['music-metadata', 'better-sqlite3', 'electron-liquid-glass'],
              },
            },
          },
        },
        preload: {
          input: path.join(__dirname, 'electron/preload.ts'),
        },
        // No renderer polyfill needed — we use contextBridge for all IPC
      }),
    ],
  }
})
