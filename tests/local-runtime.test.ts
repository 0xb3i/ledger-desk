import { createServer } from 'node:net';
import { get, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalApp, startLocalServer } from '../src/local/server';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import type { ApiEnv } from '../src/server/types';
import type { Backup } from '../src/shared/contracts';
import { createTransaction } from '../src/server/ledger/repository';
import { parseCmb } from '../src/server/ledger/domain';
import { cleanupExpiredSecurityState } from '../src/server';

let directory: string, assetsDir: string, db: LocalDatabase;
let local: ReturnType<typeof createLocalApp>;
const migrationsDir = new URL('../migrations/', import.meta.url).pathname;
const host = '127.0.0.1:43927';
const origin = `http://${host}`;
const input = { occurredAt: '2026-11-02T12:00:00+08:00', amount: '12.30', kind: 'expense', description: '本地隔离测试', accountId: 'cmb-default' };
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return local.fetch(new Request(origin + path, { method, headers: { Host: host, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
async function login() {
  const response = await request('/local/open', 'GET', undefined, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe('/');
  const cookie = response.headers.get('Set-Cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
  return { Cookie: cookie.split(';')[0], Origin: origin };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qingji-http-test-'));
  assetsDir = join(directory, 'dist');
  await mkdir(assetsDir);
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>隔离界面</title>');
  await writeFile(join(assetsDir, 'bundle.js'), 'export {};');
  db = new LocalDatabase(join(directory, 'data', 'ledger.sqlite'));
  await applyMigrations(db, migrationsDir);
  const integration = new Hono<ApiEnv>();
  integration.get('/feishu/status', c => c.json({ data: { configured: false } }));
  integration.post('/feishu/sync', c => c.json({ data: { accepted: true } }));
  local = createLocalApp({ db, dataDir: join(directory, 'data'), assetsDir, integrations: integration });
});
afterEach(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });

describe('本地 HTTP 会话与原 API 兼容', () => {
  it('直接入口登录，会话与本地密钥在重建应用后保持，页面由本机静态资源提供', async () => {
    expect((await request('/api/transactions')).status).toBe(401);
    const auth = await login();
    expect(await (await request('/api/session', 'GET', undefined, auth)).json()).toMatchObject({ data: { authenticated: true } });
    const firstKey = await readFile(join(directory, 'data/local-access-key'), 'utf8');
    local = createLocalApp({ db, dataDir: join(directory, 'data'), assetsDir });
    expect((await request('/api/transactions', 'GET', undefined, auth)).status).toBe(200);
    expect(await readFile(join(directory, 'data/local-access-key'), 'utf8')).toBe(firstKey);
    expect((await stat(join(directory, 'data/local-access-key'))).mode & 0o777).toBe(0o600);
    expect(await (await request('/')).text()).toContain('隔离界面');
    expect((await request('/bundle.js')).status).toBe(200);
    expect(await (await request('/transactions', 'GET', undefined, { Accept: 'text/html' })).text()).toContain('隔离界面');
    expect((await request('/missing.js')).status).toBe(404);
  });

  it('页面、API、登录入口和缺失资源不缓存，更新后不会复用旧页面', async () => {
    for (const path of ['/', '/transactions']) {
      const response = await request(path, 'GET', undefined, { Accept: 'text/html' });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('隔离界面');
      expect(response.headers.get('Cache-Control'), path).toBe('no-store');
    }
    for (const [path, status] of [
      ['/api/health', 200], ['/api/transactions', 401], ['/local/open', 303],
      ['/bundle.js', 200], ['/assets/missing-a1b2c3d4.js', 404],
    ] as const) {
      const response = await request(path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get('Cache-Control'), path).toBe('no-store');
    }
    const auth = await login();
    const response = await request('/api/transactions', 'GET', undefined, auth);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('带内容 hash 的构建资源可长期缓存，返回实际静态文件', async () => {
    const asset = 'export const fixture = "hashed-build-asset";';
    await mkdir(join(assetsDir, 'assets'));
    await writeFile(join(assetsDir, 'assets/index-a1b2c3d4.js'), asset);
    const response = await request('/assets/index-a1b2c3d4.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('javascript');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe(asset);
  });

  it('错误Host、跨站入口、跨站写入和未认证集成都被拒绝', async () => {
    expect((await request('/api/health', 'GET', undefined, { Host: 'evil.test' })).status).toBe(403);
    expect((await request('/local/open', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await request('/local/open', 'GET', undefined, { Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request('/local/open', 'GET', undefined, { 'Sec-Fetch-Mode': 'no-cors' })).status).toBe(403);
    expect((await request('/api/integrations/feishu/status')).status).toBe(401);
    const auth = await login();
    expect((await request('/api/integrations/feishu/status', 'GET', undefined, auth)).status).toBe(200);
    expect((await request('/api/integrations/feishu/sync', 'POST', {}, { ...auth, Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request('/api/integrations/feishu/sync', 'POST', {}, auth)).status).toBe(200);
    expect((await request('/api/integrations/feishu/sync', 'POST', {}, { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(400);
    expect((await request('/api/transactions', 'POST', input, { ...auth, Origin: 'https://evil.test', 'Idempotency-Key': 'unsafe-origin-test' })).status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(0);
  });

  it('手工入账、重试、备份恢复及冲突仍走同一账本契约', async () => {
    const auth = await login();
    const first = await request('/api/transactions', 'POST', input, { ...auth, 'Idempotency-Key': 'local-http-key' });
    expect(first.status).toBe(201);
    expect((await request('/api/transactions', 'POST', input, { ...auth, 'Idempotency-Key': 'local-http-key' })).status).toBe(200);
    const backup = (await (await request('/api/backup', 'GET', undefined, auth)).json() as { data: Backup }).data;
    expect(backup.transactions).toHaveLength(1);
    expect(backup.receipts).toHaveLength(1);
    await db.batch([db.prepare('DELETE FROM transaction_audit'), db.prepare('DELETE FROM transactions')]);
    expect((await request('/api/backup/restore', 'POST', backup, auth)).status).toBe(200);
    expect((await request('/api/transactions', 'POST', input, { ...auth, 'Idempotency-Key': 'local-http-key' })).status).toBe(200);
    backup.accounts.push({ id: 'rollback-account', name: '不应创建', bank: '', currency: 'CNY', archived: false });
    backup.transactions[0].amountCents = 1;
    expect((await request('/api/backup/restore', 'POST', backup, auth)).status).toBe(409);
    expect(await db.prepare("SELECT id FROM accounts WHERE id='rollback-account'").first()).toBeNull();
    expect(await db.prepare('SELECT amount_cents FROM transactions').first('amount_cents')).toBe(1230);
  });

  it.each(['0.00', '-0.15'])('bootstrap 保留最近来源余额 %s', async balance => {
    const parsed = parseCmb({ amount: '1.00', transaction_time: '2026-11-02T12:00:00+08:00', transaction_type: 'purchase', direction: 'outflow',
      description: '余额隔离测试', transaction_fingerprint: 'local-balance-fixture', bank: '招商银行', currency: 'CNY', parser_version: '1.1.4', balance }, 'cmb-default');
    await createTransaction(db, parsed.transaction, { source: 'shortcut', scope: 'shortcut:cmb-default', key: 'local-balance-key', sourceDetails: parsed.sourceDetails });
    const auth = await login();
    const result = await (await request('/api/bootstrap', 'GET', undefined, auth)).json() as { data: Record<string, unknown> };
    expect(result.data.bankBalance).toMatchObject({ amountCents: balance === '0.00' ? 0 : -15 });
  });

  it('共享定期清理只删除过期会话和限流窗口', async () => {
    const auth = await login();
    await db.prepare('INSERT INTO sessions(token_hash,owner_tag,created_at,expires_at) VALUES(?,?,?,?)').bind('expired-test', 'test-owner', 0, 1).run();
    await db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,?,?)').bind('expired-window', 1, 1).run();
    await cleanupExpiredSecurityState(db);
    expect(await db.prepare("SELECT token_hash FROM sessions WHERE token_hash='expired-test'").first()).toBeNull();
    expect(await db.prepare("SELECT key FROM rate_limits WHERE key='expired-window'").first()).toBeNull();
    expect(await (await request('/api/session', 'GET', undefined, auth)).json()).toMatchObject({ data: { authenticated: true } });
  });

  it('真实 Node 服务只监听回环地址，退出后可重新打开持久数据库', async () => {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const runtime = await startLocalServer({ dataDir: join(directory, 'network-data'), assetsDir, migrationsDir, port, feishuConfig: null });
    try {
      expect(runtime.server.address()).toMatchObject({ address: '127.0.0.1', port });
      expect(await (await fetch(runtime.origin + '/api/health')).json()).toMatchObject({ data: { status: 'ok' } });
      // fetch intentionally identifies itself as cors; only browser navigation
      // (or a direct native client) may create the automatic local session.
      expect((await fetch(runtime.origin + '/local/open', { redirect: 'manual' })).status).toBe(403);
      const response = await new Promise<{ status: number | undefined; cookies: string[] }>((resolve, reject) => {
        get(runtime.origin + '/local/open', { headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }, response => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode, cookies: response.headers['set-cookie'] ?? [] }));
        }).on('error', reject);
      });
      expect(response.status).toBe(303);
      expect(response.cookies.join(';')).toContain('pd_session=');
      const cookie = response.cookies[0].split(';')[0];
      const streamed = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const outgoing = httpRequest(runtime.origin + '/api/transactions', { method: 'POST', headers: {
          Cookie: cookie, Origin: runtime.origin, 'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked', 'Idempotency-Key': 'native-chunked-request',
        } }, response => {
          const chunks: string[] = [];
          response.setEncoding('utf8');
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: chunks.join('') }));
        });
        outgoing.on('error', reject);
        const body = JSON.stringify(input);
        outgoing.write(body.slice(0, 12));
        outgoing.end(body.slice(12));
      });
      expect.soft(streamed.status, streamed.body).toBe(201);
      const logout = await fetch(runtime.origin + '/api/session', { method: 'DELETE', headers: { Cookie: cookie, Origin: runtime.origin } });
      expect.soft(logout.status).toBe(200);
      expect.soft(logout.headers.get('set-cookie')).toContain('Max-Age=0');
      const session = await (await fetch(runtime.origin + '/api/session', { headers: { Cookie: cookie } })).json();
      expect(session).toMatchObject({ data: { authenticated: false } });
    } finally { await runtime.close(); }
    const reopened = new LocalDatabase(join(directory, 'network-data/ledger.sqlite'));
    expect(await reopened.prepare('SELECT COUNT(*) FROM accounts').first('COUNT(*)')).toBe(1);
    reopened.close();
  });
});
