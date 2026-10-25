import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 局域网联机主场景：dev server 监听 0.0.0.0，其他设备可直接访问 http://<开发机IP>:5173
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
