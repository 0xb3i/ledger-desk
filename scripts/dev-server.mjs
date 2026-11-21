/* 开发用本地服务：用 Vite 直接加载 TypeScript 源码启动真实后端，数据放在隔离目录，不碰安装版轻记。
   用法：QINGJI_DEV_DATA_DIR=/abs/path node scripts/dev-server.mjs（默认 work/dev-data，端口 43928） */
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const vite = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
const { startLocalServer } = await vite.ssrLoadModule('/src/local/server.ts');
const runtime = await startLocalServer({
  dataDir: process.env.QINGJI_DEV_DATA_DIR ?? resolve(root, 'work/dev-data'),
  port: Number(process.env.QINGJI_DEV_API_PORT ?? 43928),
  assetsDir: root,
  migrationsDir: resolve(root, 'migrations'),
});
console.log(`轻记开发服务已启动：${runtime.origin}（前端请打开 http://127.0.0.1:5173/local/open）`);
const stop = () => { void runtime.close().finally(() => vite.close()); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
