import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/server';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import type { Env } from '../src/server/types';
import type { CurrentBackup, WishlistInput, WishlistItem } from '../src/shared/contracts';

const origin = 'https://wishlist-backup.test';
const accessKey = `pd_owner_${'isolated-backup-test'.repeat(4)}`;
let db: LocalDatabase, env: Env, cookie: string;
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(`${origin}/api${path}`, { method,
    headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}
async function createItem(input: Partial<WishlistInput> = {}) {
  const response = await request('/wishlist', 'POST', {
    id: crypto.randomUUID(), title: '备份隔离测试心愿', amount: '123.45', url: 'https://example.com/product', note: '仅测试使用', ...input,
  });
  expect(response.status).toBe(201);
  return (await response.json() as { data: WishlistItem }).data;
}
async function exportBackup() {
  const response = await request('/backup');
  expect(response.status).toBe(200);
  return (await response.json() as { data: CurrentBackup }).data;
}
beforeEach(async () => {
  db = new LocalDatabase(':memory:');
  await applyMigrations(db, resolve('migrations'));
  env = { DB: db, OWNER_ACCESS_KEY: accessKey, ASSETS: {} as Fetcher };
  cookie = '';
  const login = await request('/session', 'POST', { accessKey });
  expect(login.status).toBe(200);
  cookie = login.headers.get('Set-Cookie')!.split(';')[0];
});
afterEach(() => db.close());

describe('心愿单全应用备份', () => {
  it('v6 往返保留金额、未知价格、已购、已移除、版本和账目，重复恢复只跳过', async () => {
    await createItem({ amount: null, title: '未定价格' });
    const purchased = await createItem({ title: '已经买到' });
    expect((await request(`/wishlist/${purchased.id}/status`, 'POST', { status: 'purchased', version: 1 })).status).toBe(200);
    const deleted = await createItem({ title: '已移除' });
    expect((await request(`/wishlist/${deleted.id}`, 'DELETE', { version: 1 })).status).toBe(200);
    const transaction = await app.request(`${origin}/api/transactions`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'wishlist-backup-ledger' },
      body: JSON.stringify({ occurredAt: '2026-11-01T12:00:00+08:00', kind: 'expense', amount: '17.83', description: '隔离账目', accountId: 'cmb-default' }),
    }, env);
    expect(transaction.status).toBe(201);
    const backup = await exportBackup();
    expect(backup.schemaVersion).toBe(7);
    expect(backup.wishlistItems).toHaveLength(3);
    expect(backup.wishlistItems.find(item => item.id === purchased.id)).toMatchObject({ status: 'purchased', amountCents: 12345, version: 2 });
    expect(backup.wishlistItems.find(item => item.id === deleted.id)?.deletedAt).not.toBeNull();
    expect(backup.wishlistItems.find(item => item.title === '未定价格')?.amountCents).toBeNull();
    const serialized = JSON.stringify(backup);
    expect(serialized).not.toContain(accessKey);
    expect(serialized).not.toContain('create_payload_hash');
    expect(serialized).not.toContain('token_hash');
    const originalHash = await db.prepare('SELECT create_payload_hash FROM wishlist_items WHERE id=?').bind(purchased.id).first<string>('create_payload_hash');
    expect(serialized).not.toContain(originalHash!);
    await db.batch(['transaction_audit', 'transactions', 'wishlist_items'].map(table => db.prepare(`DELETE FROM ${table}`)));

    const result = await request('/backup/restore', 'POST', backup);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ data: { inserted: 1, skipped: 0, wishlistInserted: 3, wishlistSkipped: 0, subscriptionsInserted: 0, subscriptionsSkipped: 0, budgetRestored: false } });
    const restored = await exportBackup();
    expect(restored.wishlistItems).toEqual(backup.wishlistItems);
    expect(restored.transactions).toEqual(backup.transactions);
    expect(restored.receipts).toEqual(backup.receipts);
    expect(await db.prepare('SELECT create_payload_hash FROM wishlist_items WHERE id=?').bind(purchased.id).first('create_payload_hash')).toBeNull();
    const repeated = await request('/backup/restore', 'POST', backup);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ data: { inserted: 0, skipped: 1, wishlistInserted: 0, wishlistSkipped: 3, subscriptionsInserted: 0, subscriptionsSkipped: 0, budgetRestored: false } });
  });

  it.each([1, 2, 3, 4, 5])('旧 v%s 备份仍可恢复，保留已有心愿和创建请求哈希', async schemaVersion => {
    const item = await createItem();
    const before = await db.prepare('SELECT * FROM wishlist_items WHERE id=?').bind(item.id).first();
    const exported = await exportBackup();
    const { wishlistItems: _, ...old } = exported;
    const legacy = { ...old, schemaVersion, categories: schemaVersion < 4
      ? old.categories.map(({ id, name, kind }) => ({ id, name, kind })) : old.categories };
    const result = await request('/backup/restore', 'POST', legacy);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ data: { inserted: 0, skipped: 0, wishlistInserted: 0, wishlistSkipped: 0, subscriptionsInserted: 0, subscriptionsSkipped: 0, budgetRestored: false } });
    expect(await db.prepare('SELECT * FROM wishlist_items WHERE id=?').bind(item.id).first()).toEqual(before);
  });

  it('旧心愿与本地编辑冲突时全部回滚，包含同批新增账户和心愿', async () => {
    const item = await createItem();
    const backup = await exportBackup();
    expect((await request(`/wishlist/${item.id}`, 'PUT', {
      title: '本地人工编辑', amount: '888.88', url: '', note: '这次编辑须保留', version: item.version,
    })).status).toBe(200);
    const current = await db.prepare('SELECT * FROM wishlist_items WHERE id=?').bind(item.id).first();
    backup.accounts.push({ id: 'wishlist-rollback-account', name: '不应新增', bank: '', currency: 'CNY', archived: false });
    const newId = crypto.randomUUID();
    backup.wishlistItems.unshift({ ...backup.wishlistItems[0], id: newId, title: '不应新增的心愿' });
    const response = await request('/backup/restore', 'POST', backup);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'RESTORE_CONFLICT' } });
    expect(await db.prepare('SELECT * FROM wishlist_items WHERE id=?').bind(item.id).first()).toEqual(current);
    expect(await db.prepare('SELECT id FROM wishlist_items WHERE id=?').bind(newId).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM accounts WHERE id='wishlist-rollback-account'").first()).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM restore_guards').first('count')).toBe(0);
  });

  it('相同心愿跳过时保留原创建请求，恢复不改变幂等重试结果', async () => {
    const id = crypto.randomUUID();
    const input = { id, title: '原始请求', amount: '12.50', url: '', note: '' };
    expect((await request('/wishlist', 'POST', input)).status).toBe(201);
    const backup = await exportBackup();
    expect((await request('/backup/restore', 'POST', backup)).status).toBe(200);
    expect((await request('/wishlist', 'POST', input)).status).toBe(200);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM wishlist_items').first('count')).toBe(1);
  });

  it('拒绝缺失清单、重复 ID、非法金额/链接与不一致购买状态，不写入任何记录', async () => {
    await createItem();
    const original = await exportBackup();
    const { wishlistItems: _, ...missing } = original;
    const invalid = [missing, { ...original, wishlistItems: [original.wishlistItems[0], original.wishlistItems[0]] },
      ...[{ amountCents: 1.5 }, { amountCents: -1 }, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.com' },
        { status: 'purchased', purchasedAt: null }, { status: 'wanted', purchasedAt: '2026-11-01T00:00:00.000Z' }]
        .map(change => ({ ...original, wishlistItems: [{ ...original.wishlistItems[0], ...change }] })),
    ];
    for (const backup of invalid) expect((await request('/backup/restore', 'POST', backup)).status).toBe(422);
    expect((await exportBackup()).wishlistItems).toEqual(original.wishlistItems);
  });
});
