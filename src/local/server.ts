import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cleanupExpiredSecurityState, createApiApp } from '../server';
import { ApiError } from '../server/errors';
import { findSession, startSession } from '../server/security';
import type { ApiEnv, Env } from '../server/types';
import { LocalDatabase } from './database';
import { applyMigrations } from './migrations';
import { createFeishuIntegration, type FeishuConfig } from './feishu';
import { createMailIntegration, type MailConfig, type MailTransport } from './mail';
import type { MailSecretStore } from './keychain';

export const DEFAULT_PORT = 43927;

function ownerKey(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'local-access-key');
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, `pd_local_${randomBytes(32).toString('base64url')}\n`); }
    finally { closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: string;
  try { key = readFileSync(descriptor, 'utf8').trim(); }
  finally { closeSync(descriptor); }
  if (!/^pd_local_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('本地会话密钥损坏，请从备份恢复；不会自动覆盖原文件。');
  chmodSync(path, 0o600);
  return key;
}

export function createLocalApp(options: {
  db: D1Database; dataDir: string; assetsDir: string; port?: number; integrations?: Hono<ApiEnv>;
}) {
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本地端口必须介于 1 和 65535。');
  if (!statSync(join(options.assetsDir, 'index.html')).isFile()) throw new Error('缺少本地页面，请先构建应用。');
  const authority = `127.0.0.1:${port}`, origin = `http://${authority}`;
  const env: Env = { DB: options.db, OWNER_ACCESS_KEY: ownerKey(options.dataDir) };
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    if (c.req.header('Host') !== authority || new URL(c.req.url).origin !== origin) {
      return c.json({ error: { code: 'INVALID_HOST', message: '请通过本机轻记启动入口访问。' } }, 403);
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    await next();
    // A saved HTML shell must not keep loading the previous release after an
    // application update. Only content-hashed build assets can be immutable.
    c.header('Cache-Control', c.req.path.startsWith('/assets/') && c.res.status === 200
      ? 'public, max-age=31536000, immutable'
      : 'no-store');
  });
  app.get('/local/open', async c => {
    c.header('Cache-Control', 'no-store');
    const site = c.req.header('Sec-Fetch-Site'), mode = c.req.header('Sec-Fetch-Mode'), destination = c.req.header('Sec-Fetch-Dest');
    if ((site && !['none', 'same-origin'].includes(site)) || (mode && mode !== 'navigate') ||
        (destination && destination !== 'document') || (c.req.header('Origin') && c.req.header('Origin') !== origin)) {
      return c.json({ error: { code: 'INVALID_LOCAL_ENTRY', message: '请直接打开本机轻记入口。' } }, 403);
    }
    if (!await findSession(c)) await startSession(c, env.OWNER_ACCESS_KEY);
    return c.redirect('/', 303);
  });
  app.route('/', createApiApp(options.integrations));
  app.get('*', serveStatic({ root: options.assetsDir }));
  app.get('*', async (c, next) => {
    if (!c.req.header('Accept')?.includes('text/html')) return c.notFound();
    return serveStatic({ path: join(options.assetsDir, 'index.html') })(c, next);
  });
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(JSON.stringify({ event: 'local_request_failed', errorType: error.name }));
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '本地服务暂未完成操作，请稍后重试。' } }, 500);
  });
  return { app, env, origin, fetch: (request: Request) => app.fetch(request, env) };
}

export async function startLocalServer(options: {
  dataDir: string; assetsDir: string; migrationsDir: string; port?: number;
  feishuConfig?: FeishuConfig | null;
  mailConfig?: MailConfig | null;
  mailSecretStore?: MailSecretStore;
  mailTransport?: MailTransport;
}) {
  const dataDir = resolve(options.dataDir);
  const db = new LocalDatabase(join(dataDir, 'ledger.sqlite'));
  let feishuIntegration: Awaited<ReturnType<typeof createFeishuIntegration>> | undefined;
  let mailIntegration: Awaited<ReturnType<typeof createMailIntegration>> | undefined;
  try {
    await applyMigrations(db, options.migrationsDir);
    await cleanupExpiredSecurityState(db);
    // Feishu background polling is retired; keep routes mounted only as inactive/explicit legacy support.
    feishuIntegration = await createFeishuIntegration({ db, dataDir, config: options.feishuConfig ?? null });
    mailIntegration = await createMailIntegration({
      db,
      dataDir,
      config: options.mailConfig,
      secretStore: options.mailSecretStore,
      transport: options.mailTransport,
    });
    const integrations = new Hono<ApiEnv>();
    integrations.route('/', mailIntegration.routes);
    integrations.route('/', feishuIntegration.routes);
    const local = createLocalApp({ db, dataDir, assetsDir: resolve(options.assetsDir), port: options.port, integrations });
    // Keep the adapter's Request/Response wrappers: bodyLimit reconstructs its
    // lightweight incoming Request for chunked and bodyless DELETE requests.
    const server = createAdaptorServer({ fetch: local.fetch, hostname: '127.0.0.1',
      serverOptions: { requestTimeout: 90_000, headersTimeout: 15_000 } });
    await new Promise<void>((resolveStarted, rejectStarted) => {
      server.once('error', rejectStarted);
      server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => { server.off('error', rejectStarted); resolveStarted(); });
    });
    mailIntegration.start();
    const cleanupTimer = setInterval(() => {
      void cleanupExpiredSecurityState(db).catch(() => console.error(JSON.stringify({ event: 'security_cleanup_failed' })));
    }, 60 * 60_000);
    cleanupTimer.unref();
    let stopping: Promise<void> | undefined;
    const close = () => stopping ??= (async () => {
      clearInterval(cleanupTimer);
      const closed = new Promise<void>((resolveClosed, rejectClosed) => server.close(error => error ? rejectClosed(error) : resolveClosed()));
      try {
        const results = await Promise.allSettled([closed, mailIntegration!.stop(), feishuIntegration!.stop()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      finally { db.close(); }
    })();
    return { ...local, server, db, integration: mailIntegration, feishuIntegration, close };
  } catch (error) {
    await mailIntegration?.stop();
    await feishuIntegration?.stop();
    db.close();
    throw error;
  }
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('轻记本地服务需要 Node.js 24 或更新版本。');
  if (process.env.QINGJI_HOST && process.env.QINGJI_HOST !== '127.0.0.1') throw new Error('轻记只允许监听 127.0.0.1。');
  const dataDir = process.env.QINGJI_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) throw new Error('请通过轻记启动器启动，或设置绝对路径 QINGJI_DATA_DIR。');
  const releaseDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = await startLocalServer({
    dataDir, port: process.env.QINGJI_PORT ? Number(process.env.QINGJI_PORT) : DEFAULT_PORT,
    assetsDir: process.env.QINGJI_STATIC_DIR ?? join(releaseDir, 'dist'),
    migrationsDir: process.env.QINGJI_MIGRATIONS_DIR ?? join(releaseDir, 'migrations'),
  });
  console.log(`轻记已启动：${runtime.origin}/local/open`);
  const shutdown = () => { void runtime.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    // Startup failures may contain paths, but never print config objects or credentials.
    console.error(error instanceof Error ? error.message : '轻记启动失败。');
    process.exitCode = 1;
  });
}
