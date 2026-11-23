import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { Hono } from 'hono';
import { normalizeInput } from '../src/server/ledger/domain';
import { changeStatus, createTransaction, updateTransaction } from '../src/server/ledger/repository';
import { getSummary, listTransactions } from '../src/server/ledger/queries';
import type { TransactionInput } from '../src/shared/contracts';
import { ingestRoutes, ledgerRoutes } from '../src/server/ledger/routes';
import { ApiError } from '../src/server/errors';
import type { ApiEnv, Env } from '../src/server/types';

let runtime: Miniflare;
let db: D1Database;
const base: TransactionInput = {
  occurredAt: '2026-11-01T12:00:00+08:00', amount: '100.29', kind: 'expense',
  description: '集成测试交易', counterparty: '测试商户', accountId: 'account-test', categoryId: 'food-test',
};
async function create(key: string, overrides: Partial<TransactionInput> = {}, fingerprint?: string) {
  return createTransaction(db, normalizeInput({ ...base, ...overrides }), {
    key, scope: fingerprint ? 'shortcut:account-test' : 'manual', source: fingerprint ? 'shortcut' : 'manual', fingerprint,
  });
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } };', d1Databases: { DB: 'ledger-test-db' }, compatibilityDate: '2026-08-06' });
  db = await runtime.getD1Database('DB') as unknown as D1Database;
  await db.prepare('CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, bank TEXT, currency TEXT, archived INTEGER NOT NULL DEFAULT 0)').run();
  await db.prepare('CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, kind TEXT)').run();
  await db.prepare("INSERT INTO accounts VALUES ('account-test','测试账户','测试银行','CNY',0)").run();
  await db.prepare("INSERT INTO categories VALUES ('food-test','餐饮','expense')").run();
  for (const name of ['0002_ledger.sql', '0004_fixed_expenses.sql', '0005_category_rules.sql', '0006_custom_categories.sql', '0007_transfer_direction.sql', '0015_subcategory_tags.sql', '0016_subcategory_catalog.sql', '0017_tag_icons.sql', '0018_transaction_tag_override.sql', '0019_dine_in_tag.sql', '0020_takeout_platforms.sql', '0021_fixed_expense_exclusion.sql', '0022_tag_category_cleanup.sql', '0024_subscriptions.sql', '0025_subscription_end_and_import.sql']) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    // Send trigger bodies whole, without splitting their inner statements.
    const triggerStart = migration.indexOf('CREATE TRIGGER');
    const prefix = triggerStart === -1 ? migration : migration.slice(0, triggerStart);
    for (const statement of prefix.split(';').filter((s) => s.trim())) await db.prepare(statement).run();
    if (triggerStart === -1) continue;
    const triggers = migration.slice(triggerStart).split(/(?<=END;)\s*(?=CREATE TRIGGER)/);
    for (const trigger of triggers) await db.prepare(trigger).run();
  }
}, 30000);

beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM transaction_audit'), db.prepare('DELETE FROM transactions')]);
});
afterAll(async () => { await runtime?.dispose(); });

describe('D1 账目写入一致性', () => {
  it('并发重复请求只创建一条账目且只产生一条审计', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => create('same-key-12345')));
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM transactions').first('count')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM transaction_audit').first('count')).toBe(1);
  });
  it('同一幂等键不同内容返回冲突，不覆盖既有金额', async () => {
    await create('different-payload');
    await expect(create('different-payload', { amount: '120.00' })).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect((await listTransactions(db, {})).items[0].amountCents).toBe(10029);
  });
  it('相同指纹不同请求保存待核对，暂不重复影响统计', async () => {
    const [a, b] = await Promise.all([create('fingerprint-one', {}, 'fingerprint-a'), create('fingerprint-two', {}, 'fingerprint-a')]);
    expect([a.transaction.reviewStatus, b.transaction.reviewStatus].sort()).toEqual(['confirmed', 'pending']);
    const summary = await getSummary(db, '2026-11');
    expect(summary.expenseCents).toBe(10029);
    expect(summary.pendingCount).toBe(1);
    expect((await listTransactions(db, { status: 'pending' })).total).toBe(1);
  });
  it('修改采用乐观锁并记录前后版本；撤销可恢复', async () => {
    const { transaction } = await create('edit-source-123');
    const updated = await updateTransaction(db, transaction.id, normalizeInput({ ...base, amount: '52.10' }), transaction.version);
    expect(updated.version).toBe(2);
    expect(updated.amountCents).toBe(5210);
    await expect(updateTransaction(db, transaction.id, normalizeInput(base), 1)).rejects.toMatchObject({ status: 409 });
    const archived = await changeStatus(db, transaction.id, 2, 'archive');
    expect(archived.deletedAt).not.toBeNull();
    expect((await getSummary(db, '2026-11')).expenseCents).toBe(0);
    expect((await listTransactions(db, { deleted: 'true' })).total).toBe(1);
    const restored = await changeStatus(db, transaction.id, 3, 'restore');
    expect(restored.deletedAt).toBeNull();
    expect(restored.version).toBe(4);
    const history = await db.prepare('SELECT version, action FROM transaction_audit ORDER BY id').all();
    expect(history.results).toEqual([{ version: 1, action: 'created' }, { version: 2, action: 'updated' }, { version: 3, action: 'archived' }, { version: 4, action: 'restored' }]);
  });
  it('确认待核对记录才计入汇总，重复确认不会静默改版本', async () => {
    await create('confirm-first', {}, 'repeat-a');
    const { transaction } = await create('confirm-second', {}, 'repeat-a');
    const confirmed = await changeStatus(db, transaction.id, 1, 'confirm');
    expect(confirmed.reviewStatus).toBe('confirmed');
    expect((await getSummary(db, '2026-11')).expenseCents).toBe(20058);
    await expect(changeStatus(db, transaction.id, 2, 'confirm')).rejects.toMatchObject({ status: 409 });
  });
});

describe('账本统计与查询语义', () => {
  it('收入、支出、退款、转账分别计算，月末按北京时间归属', async () => {
    await create('nov-expense');
    await create('nov-income', { amount: '1000', kind: 'income', categoryId: null });
    await create('nov-refund', { amount: '10.25', kind: 'refund' });
    await create('nov-transfer', { amount: '500', kind: 'transfer', transferDirection: 'outflow', categoryId: null });
    await create('prev-month', { amount: '25', occurredAt: '2026-10-31T15:59:59Z' });
    await create('first-nov', { amount: '1', occurredAt: '2026-10-31T16:00:00Z' });
    await create('first-dec', { amount: '999', occurredAt: '2026-11-30T16:00:00Z' });
    const summary = await getSummary(db, '2026-11', new Date('2026-12-01T00:00:00+08:00'));
    expect(summary).toMatchObject({ expenseCents: 60129, incomeCents: 100000, refundCents: 1025, transferCents: 50000, netExpenseCents: 59104, netIncomeCents: 40896, count: 5, pendingCount: 0 });
    expect(summary.previous.expenseCents).toBe(2500);
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily[0]).toEqual({ date: '2026-11-01', expenseCents: 60129, incomeCents: 100000, refundCents: 1025, fixedExpenseCents: 0 });
    expect(summary.categories).toEqual([{ categoryId: 'transfer', name: '转出', amountCents: 50000, count: 1 }, { categoryId: 'food-test', name: '餐饮', amountCents: 10129, count: 2 }]);
    expect(summary.incomeCategories).toEqual([{ categoryId: null, name: '未分类', amountCents: 100000, count: 1 }]);
  });
  it('查询按日期、分类筛选，搜索通配符按字面值匹配', async () => {
    await create('literal-search', { description: '折扣 10%_ 测试', categoryId: null });
    await create('normal-search', { description: '普通测试' });
    expect((await listTransactions(db, { search: '%_' })).total).toBe(1);
    expect((await listTransactions(db, { categoryId: 'uncategorized' })).total).toBe(1);
    expect((await listTransactions(db, { date: '2026-11-01' })).total).toBe(2);
    expect((await listTransactions(db, { date: '2026-11-02' })).total).toBe(0);
    await expect(listTransactions(db, { date: '2026-02-30' })).rejects.toMatchObject({ status: 422 });
  });
  it('校验引用和分类用途，失败时不产生账目或审计', async () => {
    await expect(create('wrong-account', { accountId: 'missing' })).rejects.toMatchObject({ status: 422 });
    await expect(create('wrong-category', { kind: 'income' })).rejects.toMatchObject({ status: 422 });
    expect((await listTransactions(db, {})).total).toBe(0);
  });
});

describe('账本 HTTP 契约', () => {
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => { c.set('device', { id: 'test-device', accountId: 'account-test' }); await next(); });
  app.route('/api', ledgerRoutes);
  app.route('/api/ingest', ingestRoutes);
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    throw error;
  });
  const payload = {
    amount: '100.29', transaction_time: '2026-11-01T12:00:00+08:00', transaction_type: 'purchase', direction: 'outflow',
    description: 'HTTP 集成测试', transaction_fingerprint: 'http-fingerprint', bank: '招商银行', currency: 'CNY', parser_version: '1.1.4', balance: '12345.67', transaction_time_raw: '11月1日12:00',
  };
  const send = (key: string, body: unknown) => app.request('/api/ingest/cmb', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
  }, { DB: db } as Env);
  it('真实解析器字段经 HTTP 入账，重试返回同一 ID 与 duplicate', async () => {
    const first = await send('http-first-key', payload);
    const initial = await first.json() as { data: { status: string; transactionId: string } };
    expect(first.status).toBe(201);
    expect(initial.data.status).toBe('created');
    const second = await send('http-first-key', payload);
    const replay = await second.json() as typeof initial;
    expect(second.status).toBe(200);
    expect(replay.data).toMatchObject({ status: 'duplicate', transactionId: initial.data.transactionId });
    const transaction = (await listTransactions(db, {})).items[0];
    expect(transaction.sourceDetails).toEqual({ transactionType: 'purchase', direction: 'outflow', parserVersion: '1.1.4', balance: '12345.67', transactionTimeRaw: '11月1日12:00' });
    const snapshot = await db.prepare('SELECT snapshot FROM transaction_audit WHERE transaction_id = ?').bind(transaction.id).first<string>('snapshot');
    expect(JSON.parse(snapshot!).sourceDetails).toEqual(transaction.sourceDetails);
    expect((await send('http-first-key', { ...payload, balance: '12345.68' })).status).toBe(409);
  });
  it('其他入账保存为待核对，核对前收入为零', async () => {
    const response = await send('http-credit-key', { ...payload, transaction_type: 'credit', direction: 'inflow' });
    expect((await response.json() as { data: { status: string } }).data.status).toBe('needs_review');
    expect(await getSummary(db, '2026-11')).toMatchObject({ incomeCents: 0, pendingCount: 1 });
  });
  it('缺少幂等键、未知交易类型及畸形 JSON 返回明确错误且不写入', async () => {
    const missing = await app.request('/api/transactions', { method: 'POST', body: JSON.stringify(base) }, { DB: db } as Env);
    expect(missing.status).toBe(400);
    const unknown = await send('http-unknown-key', { ...payload, transaction_type: 'unsupported' });
    expect(unknown.status).toBe(422);
    const malformed = await app.request('/api/transactions', { method: 'POST', headers: { 'Idempotency-Key': 'malformed-key' }, body: '{' }, { DB: db } as Env);
    expect(malformed.status).toBe(400);
    expect((await listTransactions(db, {})).total).toBe(0);
  });
});
