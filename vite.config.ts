import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/* 开发时把 /api 与 /local 代理到本地服务（scripts/dev-server.mjs，默认 43928）。
   本地服务只认自己的 Host/Origin，代理统一改写，会话 Cookie 仍落在开发地址上。 */
const target = `http://127.0.0.1:${process.env.QINGJI_DEV_API_PORT ?? 43928}`;
const proxy = {
  target, changeOrigin: true,
  configure: (server: { on: (event: 'proxyReq', handler: (request: { setHeader(name: string, value: string): void; getHeader(name: string): unknown; removeHeader(name: string): void }) => void) => void }) => {
    server.on('proxyReq', request => {
      if (request.getHeader('origin')) request.setHeader('origin', target);
      for (const name of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) request.removeHeader(name);
    });
  },
};
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/client', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': proxy, '/local': proxy } },
  build: { outDir: 'dist', sourcemap: false },
});
