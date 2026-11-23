import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { version } from '../../package.json';
import { ApiError } from './errors';
import type { ApiEnv, Env } from './types';
import { assertSameOrigin, endSession, findSession, requireDevice, requireSession, startSession } from './security';
import { platformRoutes } from './platform';
import { ledgerRoutes, ingestRoutes } from './ledger';
import { backupRoutes } from './backup';
import { categoryRuleRoutes } from './ledger/classification';
import { categoryRoutes } from './ledger/categories';
import { categoryDeletionRoutes } from './ledger/category-deletion';
import { wishlistRoutes } from './wishlist';
import { subscriptionRoutes } from './subscriptions';
import { budgetRoutes } from './budgets';
import { tagRoutes } from './ledger/tags';

export function createApiApp(integrations?: Hono<ApiEnv>) {
  const app = new Hono<ApiEnv>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Request-Id', c.get('requestId'));
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 8 * 1024 * 1024, onError: () => { throw new ApiError(413, 'BODY_TOO_LARGE', '文件超过 8 MB，请使用数据库备份恢复。'); } }));
  app.use('/api/*', async (c, next) => {
    if (['POST', 'PATCH', 'PUT'].includes(c.req.method)) {
      const contentType = c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new ApiError(400, 'INVALID_CONTENT_TYPE', '请求内容必须为 JSON。');
    }
    await next();
  });
  app.get('/api/health', async c => {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ data: { status: 'ok', version } });
  });
  app.get('/api/session', async c => c.json({ data: { authenticated: Boolean(await findSession(c)), version } }));
  app.post('/api/session', async c => {
    assertSameOrigin(c);
    const { accessKey } = z.object({ accessKey: z.string().min(1).max(256) }).parse(await c.req.json());
    await startSession(c, accessKey);
    return c.json({ data: { authenticated: true } });
  });
  app.delete('/api/session', async c => {
    assertSameOrigin(c);
    await endSession(c);
    return c.json({ data: { authenticated: false } });
  });
  app.use('/api/ingest/*', requireDevice);
  app.route('/api/ingest', ingestRoutes);
  app.use('/api/*', requireSession);
  app.route('/api', platformRoutes);
  app.route('/api', ledgerRoutes);
  app.route('/api', categoryRuleRoutes);
  app.route('/api', categoryRoutes);
  app.route('/api', categoryDeletionRoutes);
  app.route('/api', wishlistRoutes);
  app.route('/api', subscriptionRoutes);
  app.route('/api', budgetRoutes);
  app.route('/api', tagRoutes);
  app.route('/api', backupRoutes);
  if (integrations) app.route('/api/integrations', integrations);
  app.all('/api/*', c => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在。', requestId: c.get('requestId') } }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message, requestId: c.get('requestId') } }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: { code: 'VALIDATION_ERROR', message: '输入格式不正确，请检查必填项、长度及数据类型。', requestId: c.get('requestId') } }, 422);
    if (error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_JSON', message: '请求正文不是有效 JSON。', requestId: c.get('requestId') } }, 400);
    // Do not log database error text, request bodies or credentials: they may contain financial data.
    console.error(JSON.stringify({ event: 'request_failed', requestId: c.get('requestId'), errorType: error.name }));
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时未能完成操作，请稍后重试。', requestId: c.get('requestId') } }, 500);
  });
  return app;
}
export const app = createApiApp();
export async function cleanupExpiredSecurityState(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
    db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)),
  ]);
}
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    await cleanupExpiredSecurityState(env.DB);
  },
};
