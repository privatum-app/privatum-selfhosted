import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The local admin panel is a separate build, so the relay (which serves dist/ over the
// .onion) never ships it. Served by privatum-admin from /srv/admin.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-admin',
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: { input: 'admin.html' },
  },
});
