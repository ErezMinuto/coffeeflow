import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Manual chunk splitting reduces the main bundle size warning ("chunks
// larger than 500 kB"). Heavy deps go in their own chunks so they:
//   • can be cached separately by the browser across deploys (changing
//     app code doesn't invalidate the chart library cache)
//   • parallel-load on first visit (browser fetches multiple chunks at
//     once instead of one ~1MB file)
//
// Chunks chosen by size + change frequency: Clerk auth and Supabase
// SDK rarely change; charts (recharts) is the heaviest single dep;
// react itself benefits from being split too. Everything else stays
// in the main bundle.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'auth':         ['@clerk/clerk-react'],
          'supabase':     ['@supabase/supabase-js'],
          'charts':       ['recharts'],
          'ui':           ['lucide-react', 'date-fns'],
        },
      },
    },
  },
})
