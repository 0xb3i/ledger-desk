import { listTags } from './ledger/tags';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Account, Device } from '../shared/contracts';
import type { ApiEnv } from './types';
import { ApiError } from './errors';
import { digest, randomToken } from './security';
import { parseAmount } from './ledger/domain';
import { mapCategory } from './ledger/categories';

export function mapAccount(value: unknown): Account {
  const row = value as Record<string, unknown>;
  return { id: String(row.id), name: String(row.name), bank: String(row.bank), currency: 'CNY', archived: Boolean(row.archived) };
}
export function mapDevice(row: Record<string, unknown>): Device {
  return { id: String(row.id), name: String(row.name), accountId: String(row.account_id), prefix: String(row.prefix), createdAt: String(row.created_at), lastUsedAt: row.last_used_at as string | null, revokedAt: row.revoked_at as string | null };
}
export const platformRoutes = new Hono<ApiEnv>();
platformRoutes.get('/bootstrap', async c => {
  const [accounts, categories, balances] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM accounts ORDER BY archived,name'),
    c.env.DB.prepare('SELECT * FROM categories ORDER BY rowid'),
    c.env.DB.prepare(`SELECT t.occurred_at, json_extract(t.source_details,'$.balance') AS balance
      FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE a.bank='招商银行' AND a.archived=0 AND t.deleted_at IS NULL
        AND json_extract(t.source_details,'$.balance') IS NOT NULL
      ORDER BY t.occurred_at DESC,t.created_at DESC LIMIT 1`),
  ]);
  const latest = balances.results[0] as { occurred_at: string; balance: string } | undefined;
  let bankBalance: { amountCents: number; asOf: string } | null = null;
  if (latest && typeof latest.balance === 'string') {
    const negative = latest.balance.startsWith('-');
    const amount = negative ? latest.balance.slice(1) : latest.balance;
    const cents = /^0(?:\.0{1,2})?$/.test(amount) ? 0 : parseAmount(amount);
    bankBalance = { amountCents: negative ? -cents : cents, asOf: latest.occurred_at };
  }
  const { tags, rules: tagRules } = await listTags(c.env.DB);
  return c.json({ data: { accounts: accounts.results.map(mapAccount), categories: categories.results.map(mapCategory), tags, tagRules, bankBalance } });
});
platformRoutes.post('/accounts', async c => {
  const data = z.object({ name: z.string().trim().min(1).max(60), bank: z.string().trim().max(60).default('') }).parse(await c.req.json());
  const account: Account = { id: crypto.randomUUID(), ...data, currency: 'CNY', archived: false };
  const result = await c.env.DB.prepare('INSERT INTO accounts(id,name,bank) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING').bind(account.id, account.name, account.bank).run();
  if (!result.meta.changes) throw new ApiError(409, 'ACCOUNT_EXISTS', '已有同名账户，请使用不同名称。');
  return c.json({ data: account }, 201);
});
platformRoutes.get('/devices', async c => {
  const rows = await c.env.DB.prepare('SELECT * FROM devices ORDER BY created_at DESC').all();
  return c.json({ data: rows.results.map(mapDevice) });
});
platformRoutes.post('/devices', async c => {
  const data = z.object({ name: z.string().trim().min(1).max(60), accountId: z.string().min(1).max(100) }).parse(await c.req.json());
  if (!await c.env.DB.prepare('SELECT id FROM accounts WHERE id=? AND archived=0').bind(data.accountId).first()) throw new ApiError(422, 'INVALID_ACCOUNT', '请选择可用账户。');
  const token = randomToken('pd_device_');
  const device: Device = { id: crypto.randomUUID(), name: data.name, accountId: data.accountId, prefix: token.slice(0, 15), createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
  await c.env.DB.prepare('INSERT INTO devices(id,name,account_id,token_hash,prefix,created_at) VALUES (?,?,?,?,?,?)')
    .bind(device.id, device.name, device.accountId, await digest(token), device.prefix, device.createdAt).run();
  return c.json({ data: { device, token } }, 201);
});
platformRoutes.delete('/devices/:id', async c => {
  const result = await c.env.DB.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(new Date().toISOString(), c.req.param('id')).run();
  if (!result.meta.changes) throw new ApiError(404, 'NOT_FOUND', '未找到该快捷指令凭据。');
  return c.json({ data: { revoked: true } });
});
