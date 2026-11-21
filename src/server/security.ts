import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { ApiEnv } from './types';
import { ApiError } from './errors';

export const SESSION_COOKIE = 'pd_session';
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [ah, bh] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < ah.length; i++) difference |= ah.charCodeAt(i) ^ bh.charCodeAt(i);
  return difference === 0;
}
function ownerKey(c: Context<ApiEnv>): string {
  const key = c.env.OWNER_ACCESS_KEY;
  if (!key || key.length < 43) throw new ApiError(503, 'NOT_CONFIGURED', '服务尚未配置访问密钥，请完成部署设置。');
  return key;
}
export async function rateLimit(c: Context<ApiEnv>, scope: string, limit: number, windowSeconds: number) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const key = await digest(`${scope}:${window}`);
  const row = await c.env.DB.prepare(`INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(key, (window + 1) * windowSeconds).first<{ count: number }>();
  if (!row || row.count > limit) {
    c.header('Retry-After', String((window + 1) * windowSeconds - now));
    throw new ApiError(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试。');
  }
}
export function assertSameOrigin(c: Context<ApiEnv>) {
  const origin = c.req.header('Origin');
  if (origin !== new URL(c.req.url).origin) throw new ApiError(403, 'INVALID_ORIGIN', '请求来源不符，请刷新页面后重试。');
}
export async function findSession(c: Context<ApiEnv>): Promise<string | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie || cookie.length > 128 || !c.env.OWNER_ACCESS_KEY) return null;
  const hash = await digest(cookie);
  const session = await c.env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND owner_tag=? AND expires_at>?')
    .bind(hash, await digest(ownerKey(c)), Date.now()).first<{ token_hash: string }>();
  return session?.token_hash ?? null;
}
export async function startSession(c: Context<ApiEnv>, accessKey: string) {
  await rateLimit(c, `login:${c.req.header('CF-Connecting-IP') ?? 'local'}`, 12, 900);
  if (!await equalSecret(accessKey, ownerKey(c))) throw new ApiError(401, 'INVALID_CREDENTIALS', '访问密钥不正确。');
  const token = randomToken();
  const maxAge = 14 * 24 * 3600;
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO sessions(token_hash,owner_tag,created_at,expires_at) VALUES (?,?,?,?)')
    .bind(await digest(token), await digest(ownerKey(c)), now, now + maxAge * 1000).run();
  setCookie(c, SESSION_COOKIE, token, { path: '/', httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', maxAge });
}
export async function endSession(c: Context<ApiEnv>) {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(cookie)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
export const requireSession: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const session = await findSession(c);
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录。');
  c.set('sessionId', session);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) assertSameOrigin(c);
  await next();
};
export const requireDevice: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer (pd_device_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) throw new ApiError(401, 'INVALID_DEVICE', '缺少有效的快捷指令凭据。');
  const row = await c.env.DB.prepare(`SELECT d.id,d.account_id FROM devices d JOIN accounts a ON a.id=d.account_id
    WHERE d.token_hash=? AND d.revoked_at IS NULL AND a.archived=0`).bind(await digest(match[1])).first<{ id: string; account_id: string }>();
  if (!row) throw new ApiError(401, 'INVALID_DEVICE', '快捷指令凭据已失效，请在接入设置中重新创建。');
  await rateLimit(c, `device:${row.id}`, 120, 60);
  c.set('device', { id: row.id, accountId: row.account_id });
  await c.env.DB.prepare('UPDATE devices SET last_used_at=? WHERE id=?').bind(new Date().toISOString(), row.id).run();
  await next();
};
