import { defineConfig } from 'vite';

export default defineConfig({
  // Bind the dev/preview servers to all interfaces so the workbench is
  // reachable over the local network (e.g. Tailscale) for review on
  // other devices, not just localhost.
  server: {
    host: '0.0.0.0',
    allowedHosts: ['red-dragon', '.tail18b785.ts.net'],
    port: 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
