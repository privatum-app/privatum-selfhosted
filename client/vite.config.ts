import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The relay's CSP forbids inline scripts and styles; keep every asset external.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    fs: { allow: ['..'] },
  },
});
