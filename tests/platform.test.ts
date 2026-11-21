import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import { digest } from '../src/server/security';
import { builtinCategorySeeds } from '../src/server/ledger/categories';
import { type Backup, type Category, type CategoryRule, type CategoryRuleList, type CurrentBackup, type Transaction } from '../src/shared/contracts';

let runtime: Miniflare, env: Env;
const accessKey = `pd_owner_${'testkey'.repeat(8)}`;
const origin = 'https://dashboard.test';
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`${origin}/api${path}`, {
    method, headers: { ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env);
}
async function login() {
  const response = await request('/session', 'POST', { accessKey });
  expect(response.status).toBe(200);
  return { Cookie: response.headers.get('Set-Cookie')!.split(';')[0] };
}
const transactionInput = { occurredAt: '2026-11-01T18:15:00+08:00', kind: 'expense', amount: '20.19', description: '自动测试账目', counterparty: '测试商户', accountId: 'cmb-default', categoryId: 'food' };
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: { DB: 'platform-tests' }, compatibilityDate: '2026-08-06' });
  env = { DB: await runtime.getD1Database('DB') as unknown as D1Database, OWNER_ACCESS_KEY: accessKey, ASSETS: {} as Fetcher };
  for (const name of ['0001_platform.sql', '0002_ledger.sql', '0004_fixed_expenses.sql', '0005_category_rules.sql', '0006_custom_categories.sql', '0007_transfer_direction.sql', '0009_wishlist.sql', '0010_monthly_budget.sql', '0015_subcategory_tags.sql', '0016_subcategory_catalog.sql', '0017_tag_icons.sql', '0018_transaction_tag_override.sql', '0019_dine_in_tag.sql', '0020_takeout_platforms.sql', '0021_fixed_expense_exclusion.sql', '0022_tag_category_cleanup.sql']) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const start = sql.indexOf('CREATE TRIGGER');
    const prefix = start === -1 ? sql : sql.slice(0, start);
    for (const part of prefix.split(';').filter(p => p.trim())) await env.DB.prepare(part).run();
    if (start !== -1) for (const part of sql.slice(start).split(/(?<=END;)\s*(?=CREATE TRIGGER)/)) await env.DB.prepare(part).run();
  }
}, 30000);
beforeEach(async () => {
  env.OWNER_ACCESS_KEY = accessKey;
  await env.DB.batch(['transaction_audit', 'transactions', 'category_rules', 'wishlist_items', 'devices', 'sessions', 'rate_limits', 'restore_guards'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare("DELETE FROM accounts WHERE id != 'cmb-default'").run();
  await env.DB.prepare("DELETE FROM categories WHERE id NOT IN ('food','shopping','transport','housing','health','leisure','learning','salary','other-income','other')").run();
  await env.DB.prepare('UPDATE categories SET name_key=NULL').run();
  await env.DB.batch(builtinCategorySeeds.map(category => env.DB.prepare('UPDATE categories SET name=?,kind=?,icon=?,color=?,version=1,name_key=? WHERE id=?')
    .bind(category.name, category.kind, category.icon, category.color, category.name.toLowerCase(), category.id)));
});
afterAll(async () => { await runtime?.dispose(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('会话与权限边界', () => {
  it('公共健康可用，未登录不能读取账本或备份', async () => {
    expect((await request('/health')).status).toBe(200);
    for (const path of ['/bootstrap', '/summary', '/transactions', '/devices', '/backup']) expect((await request(path)).status).toBe(401);
  });
  it('成功登录签发 Secure HttpOnly Strict cookie，退出立即失效', async () => {
    const response = await request('/session', 'POST', { accessKey });
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
    const headers = { Cookie: cookie.split(';')[0] };
    expect((await request('/bootstrap', 'GET', undefined, headers)).status).toBe(200);
    await request('/session', 'DELETE', undefined, headers);
    expect((await request('/bootstrap', 'GET', undefined, headers)).status).toBe(401);
  });
  it('跨站提交即使持有会话也被拒绝', async () => {
    const headers = await login();
    expect((await request('/accounts', 'POST', { name: '不应创建', bank: '' }, { ...headers, Origin: 'https://attacker.test' })).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) count FROM accounts').first('count')).toBe(1);
  });
  it('轮换管理密钥使已有会话立即失效', async () => {
    const headers = await login();
    env.OWNER_ACCESS_KEY = accessKey + 'rotated';
    expect((await request('/bootstrap', 'GET', undefined, headers)).status).toBe(401);
  });
  it('数据库过期会话被拒绝', async () => {
    const headers = await login();
    await env.DB.prepare('UPDATE sessions SET expires_at=0').run();
    expect((await request('/bootstrap', 'GET', undefined, headers)).status).toBe(401);
  });
  it('错误密钥受持久化限流保护', async () => {
    // Own the clock: a real quarter-hour rollover must not split the test's request burst.
    const now = Date.UTC(2026, 10, 1, 10, 0, 0);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let i = 0; i < 12; i++) expect((await request('/session', 'POST', { accessKey: 'wrong' })).status).toBe(401);
    const blocked = await request('/session', 'POST', { accessKey });
    expect(blocked.status).toBe(429); expect(blocked.headers.get('Retry-After')).toBeTruthy();
    clock.mockReturnValue(now + 900_000);
    expect((await request('/session', 'POST', { accessKey })).status).toBe(200);
  });
  it('设备令牌只能写入绑定账户，无法读取账本，撤销立即失效', async () => {
    const headers = await login();
    const created = await request('/devices', 'POST', { name: '测试快捷指令', accountId: 'cmb-default' }, headers);
    const { data: { device, token } } = await created.json() as { data: { device: { id: string }; token: string } };
    const auth = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'device-test-1234' };
    const body = { amount: '29.80', transaction_time: '2026-11-01T09:00:00+08:00', transaction_type: 'purchase', direction: 'outflow', description: '设备测试', transaction_fingerprint: 'test-fingerprint', currency: 'CNY', bank: '招商银行', parser_version: '1.2.0', balance: '100.01' };
    expect((await request('/transactions', 'GET', undefined, auth)).status).toBe(401);
    expect((await request('/ingest/cmb', 'POST', body, headers)).status).toBe(401);
    const accepted = await request('/ingest/cmb', 'POST', body, auth);
    expect(accepted.status).toBe(201);
    expect((await accepted.json() as { data: { status: string } }).data.status).toBe('created');
    expect(await env.DB.prepare('SELECT account_id FROM transactions').first('account_id')).toBe('cmb-default');
    expect((await request('/ingest/cmb', 'POST', body, auth)).status).toBe(200);
    const list = await (await request('/devices', 'GET', undefined, headers)).text();
    expect(list).not.toContain(token); expect(list).not.toContain(await digest(token));
    await request(`/devices/${device.id}`, 'DELETE', undefined, headers);
    expect((await request('/ingest/cmb', 'POST', body, auth)).status).toBe(401);
  });
});

describe('分类规则保存即更新历史账单', () => {
  it('接口新增、修改与删除规则同步更新旧账单，保留人工选择和原请求身份', async () => {
    const headers = await login();
    const body = { ...transactionInput, description: '历史自定义商户', categoryId: null };
    const accepted = await request('/transactions', 'POST', body, { ...headers, 'Idempotency-Key': 'historical-rule-key' });
    expect(accepted.status).toBe(201);
    const original = (await accepted.json() as { data: Transaction }).data;
    const manual = await request('/transactions', 'POST', { ...body, categoryId: 'other' }, { ...headers, 'Idempotency-Key': 'manual-rule-key' });
    const manualId = (await manual.json() as { data: Transaction }).data.id;
    const created = await request('/category-rules', 'POST', { keyword: '历史自定义商户', matchType: 'contains', kind: 'expense', categoryId: 'food', enabled: true }, headers);
    expect(created.status).toBe(201);
    const rule = (await created.json() as { data: CategoryRule & { updatedTransactions: number } }).data;
    expect(rule.updatedTransactions).toBe(1);
    expect(await env.DB.prepare('SELECT category_id FROM transactions WHERE id=?').bind(original.id).first('category_id')).toBe('food');
    const changed = await request(`/category-rules/${rule.id}`, 'PATCH', { ...rule, categoryId: 'shopping' }, headers);
    expect(changed.status).toBe(200);
    const next = (await changed.json() as { data: CategoryRule & { updatedTransactions: number } }).data;
    expect(next.updatedTransactions).toBe(1);
    expect(await env.DB.prepare('SELECT category_id FROM transactions WHERE id=?').bind(original.id).first('category_id')).toBe('shopping');
    const deleted = await request(`/category-rules/${next.id}`, 'DELETE', { version: next.version }, headers);
    expect((await deleted.json() as { data: unknown }).data).toEqual({ deleted: true, updatedTransactions: 1 });
    expect(await env.DB.prepare('SELECT category_id FROM transactions WHERE id=?').bind(original.id).first('category_id')).toBeNull();
    expect(await env.DB.prepare('SELECT category_id FROM transactions WHERE id=?').bind(manualId).first('category_id')).toBe('other');
    const replay = await request('/transactions', 'POST', body, { ...headers, 'Idempotency-Key': 'historical-rule-key' });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: Transaction }).data).toMatchObject({ id: original.id, amountCents: original.amountCents, occurredAt: original.occurredAt, categorySource: 'unclassified' });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(2);
  });
});

describe('账本备份与原子恢复', () => {
  async function seedBackup() {
    const headers = await login();
    const response = await request('/transactions', 'POST', transactionInput, { ...headers, 'Idempotency-Key': 'backup-fixture-key' });
    expect(response.status).toBe(201);
    const transaction = (await response.json() as { data: Transaction }).data;
    const backup = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    return { headers, transaction, backup };
  }
  it('v4备份完整恢复自定义类目的图标颜色、规则和原请求身份', async () => {
    const { headers } = await seedBackup();
    const created = await request('/categories', 'POST', { name: '软件订阅', kind: 'expense', icon: 'laptop', color: 'sage' }, headers);
    expect(created.status).toBe(201);
    const category = (await created.json() as { data: Category }).data;
    await request('/category-rules', 'POST', { keyword: '订阅服务', matchType: 'contains', kind: 'expense', categoryId: category.id, enabled: true }, headers);
    const input = { ...transactionInput, description: '订阅服务', categoryId: null };
    const accepted = await request('/transactions', 'POST', input, { ...headers, 'Idempotency-Key': 'custom-category-backup-key' });
    expect(accepted.status).toBe(201);
    const transaction = (await accepted.json() as { data: Transaction }).data;
    const backup = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(backup.schemaVersion).toBe(7);
    expect(backup.categories).toContainEqual(category);
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions'),
      env.DB.prepare('DELETE FROM category_rules'), env.DB.prepare('DELETE FROM categories WHERE id=?').bind(category.id)]);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(200);
    const restored = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(restored.categories).toEqual(backup.categories);
    expect(restored.transactions).toEqual(backup.transactions);
    expect(restored.categoryRules).toEqual(backup.categoryRules);
    const replay = await request('/transactions', 'POST', input, { ...headers, 'Idempotency-Key': 'custom-category-backup-key' });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: Transaction }).data).toEqual(transaction);
  });
  it('v4可在新空库覆盖 pristine 默认类目，恢复改名样式以及引用它的规则账单', async () => {
    const { headers, backup } = await seedBackup();
    const food = backup.categories.find(category => category.id === 'food')!;
    expect((await request('/categories/food', 'PATCH', { ...food, name: '吃喝', icon: 'pizza', color: 'clay' }, headers)).status).toBe(200);
    expect((await request('/category-rules', 'POST', { keyword: '吃喝测试', matchType: 'contains', kind: 'expense', categoryId: 'food', enabled: true }, headers)).status).toBe(201);
    const customized = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions'), env.DB.prepare('DELETE FROM category_rules'),
      env.DB.prepare("UPDATE categories SET name='餐饮',icon='food',color='amber',version=1,name_key='餐饮' WHERE id='food'")]);
    expect((await request('/backup/restore', 'POST', customized, headers)).status).toBe(200);
    const restored = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(restored.categories).toEqual(customized.categories);
    expect(restored.transactions).toEqual(customized.transactions);
    expect(restored.categoryRules).toEqual(customized.categoryRules);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
  });
  it('pristine默认类目可以交换名称，但已使用默认类目的样式不允许被覆盖', async () => {
    const headers = await login();
    const empty = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    const food = empty.categories.find(category => category.id === 'food')!, shopping = empty.categories.find(category => category.id === 'shopping')!;
    const swap = { ...empty, categories: empty.categories.map(category => category.id === 'food' ? { ...category, name: shopping.name, version: 2 }
      : category.id === 'shopping' ? { ...category, name: food.name, version: 2 } : category) };
    expect((await request('/backup/restore', 'POST', swap, headers)).status).toBe(200);
    expect(await env.DB.prepare("SELECT name FROM categories WHERE id='food'").first('name')).toBe('购物');
    expect(await env.DB.prepare("SELECT name FROM categories WHERE id='shopping'").first('name')).toBe('餐饮');
    // Put the default seed back and use it: migration must then preserve it.
    await env.DB.prepare('UPDATE categories SET name_key=NULL').run();
    await env.DB.batch(builtinCategorySeeds.map(category => env.DB.prepare('UPDATE categories SET name=?,icon=?,color=?,version=1,name_key=? WHERE id=?')
      .bind(category.name, category.icon, category.color, category.name.toLowerCase(), category.id)));
    expect((await request('/transactions', 'POST', transactionInput, { ...headers, 'Idempotency-Key': 'used-seed-category-key' })).status).toBe(201);
    const attempt = { ...empty, categories: empty.categories.map(category => category.id === 'food' ? { ...category, icon: 'pizza', version: 2 } : category) };
    expect((await request('/backup/restore', 'POST', attempt, headers)).status).toBe(409);
    expect(await env.DB.prepare("SELECT icon FROM categories WHERE id='food'").first('icon')).toBe('food');
  });
  it('旧v3备份恢复时保留当前类目样式，新v4样式冲突整批回滚', async () => {
    const { headers, backup } = await seedBackup();
    const food = backup.categories.find(category => category.id === 'food')!;
    const legacy = { ...backup, schemaVersion: 3, categories: backup.categories.map(({ id, name, kind }) => ({ id, name, kind })) };
    const changed = await request('/categories/food', 'PATCH', { ...food, icon: 'pizza', color: 'clay' }, headers);
    expect(changed.status).toBe(200);
    expect((await request('/backup/restore', 'POST', legacy, headers)).status).toBe(200);
    expect(await env.DB.prepare("SELECT icon,color,version FROM categories WHERE id='food'").first()).toEqual({ icon: 'pizza', color: 'clay', version: 2 });
    backup.accounts.push({ id: 'style-conflict-account', name: '不应写入', bank: '', currency: 'CNY', archived: false });
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(409);
    expect(await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind('style-conflict-account').first()).toBeNull();
    expect(await env.DB.prepare("SELECT icon FROM categories WHERE id='food'").first('icon')).toBe('pizza');
  });
  it('v4缺少或非法类目图标颜色会拒绝恢复', async () => {
    const { headers, backup } = await seedBackup();
    const missing = { ...backup, categories: backup.categories.map(({ icon: _, ...category }) => category) };
    expect((await request('/backup/restore', 'POST', missing, headers)).status).toBe(422);
    const invalid = { ...backup, categories: backup.categories.map(category => ({ ...category, color: '#0000ff' })) };
    expect((await request('/backup/restore', 'POST', invalid, headers)).status).toBe(422);
    const duplicates = { ...backup, categories: [...backup.categories, { ...backup.categories[0], id: 'duplicate-category' }] };
    expect((await request('/backup/restore', 'POST', duplicates, headers)).status).toBe(422);
  });
  it('新版备份完整保留固定标记，缺失标记或非支出固定标记会被拒绝', async () => {
    const { headers, transaction } = await seedBackup();
    const changed = await request(`/transactions/${transaction.id}`, 'PATCH', { ...transactionInput, version: transaction.version, isFixed: true }, headers);
    expect(changed.status).toBe(200);
    const backup = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(backup.schemaVersion).toBe(7); expect(backup.transactions[0].isFixed).toBe(true);
    const missingFlag = { ...backup, transactions: backup.transactions.map(({ isFixed: _, ...entry }) => entry) };
    expect((await request('/backup/restore', 'POST', missingFlag, headers)).status).toBe(422);
    expect((await request('/backup/restore', 'POST', { ...backup, transactions: [{ ...backup.transactions[0], kind: 'income' }] }, headers)).status).toBe(422);
    expect((await request('/backup/restore', 'POST', { ...backup, transactions: [{ ...backup.transactions[0], isFixed: false }] }, headers)).status).toBe(409);
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(200);
    const restored = (await (await request('/transactions', 'GET', undefined, headers)).json() as { data: { items: Transaction[] } }).data.items[0];
    expect(restored).toEqual(backup.transactions[0]);
    const snapshot = await env.DB.prepare('SELECT snapshot FROM transaction_audit').first<string>('snapshot');
    expect(JSON.parse(snapshot!).isFixed).toBe(true);
  });
  it('旧schemaVersion1备份默认非固定，恢复后的原请求仍保持幂等', async () => {
    const { headers, transaction, backup } = await seedBackup();
    const legacy = { ...backup, schemaVersion: 1, transactions: backup.transactions.map(({ isFixed: _, ...entry }) => entry) };
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    expect((await request('/backup/restore', 'POST', legacy, headers)).status).toBe(200);
    const replay = await request('/transactions', 'POST', { ...transactionInput, isFixed: false }, { ...headers, 'Idempotency-Key': 'backup-fixture-key' });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: Transaction }).data).toMatchObject({ id: transaction.id, isFixed: false });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
    expect((await request('/backup/restore', 'POST', { ...legacy, transactions: [{ ...legacy.transactions[0], isFixed: true }] }, headers)).status).toBe(422);
  });
  it.each([{ source: 'shortcut', version: 2 }, { source: 'manual', version: 1 }])('旧v2备份保护人工创建或曾经编辑的空分类：$source v$version', async ({ source, version }) => {
    const { headers, backup } = await seedBackup();
    const legacy = { ...backup, schemaVersion: 2, transactions: backup.transactions.map(({ categorySource: _, categoryRuleId: _id, categoryRuleKeyword: _keyword, ...entry }) => ({ ...entry, categoryId: null, source, version })) };
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    expect((await request('/backup/restore', 'POST', legacy, headers)).status).toBe(200);
    const restored = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(restored.transactions[0]).toMatchObject({ categorySource: 'manual', categoryId: null, categoryRuleId: null, categoryRuleKeyword: null });
    expect(restored.categoryRules).toEqual([]);
  });
  it('v4在新库恢复内置规则覆盖、自定义规则及手工清空来源，原请求仍幂等', async () => {
    const headers = await login();
    const rules = (await (await request('/category-rules', 'GET', undefined, headers)).json() as { data: CategoryRuleList }).data.items;
    const builtin = rules.find(rule => rule.keyword === '打车')!;
    expect(builtin).toBeDefined();
    const disabled = await request(`/category-rules/${builtin.id}`, 'PATCH', { ...builtin, enabled: false }, headers);
    expect(disabled.status).toBe(200);
    const created = await request('/category-rules', 'POST', { keyword: '测试书籍', matchType: 'contains', kind: 'expense', categoryId: 'learning', enabled: true }, headers);
    expect(created.status).toBe(201);
    const custom = (await created.json() as { data: CategoryRule }).data;
    const autoInput = { ...transactionInput, description: '购买测试书籍', categoryId: null };
    const accepted = await request('/transactions', 'POST', autoInput, { ...headers, 'Idempotency-Key': 'classification-backup-key' });
    const transaction = (await accepted.json() as { data: Transaction }).data;
    expect(transaction).toMatchObject({ categorySource: 'rule', categoryId: 'learning', categoryRuleId: custom.id, categoryRuleKeyword: '测试书籍' });
    const changed = await request(`/transactions/${transaction.id}`, 'PATCH', { ...autoInput, categoryOverride: true, version: transaction.version }, headers);
    expect(changed.status).toBe(200);
    const backup = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(backup.categoryRules).toHaveLength(2);
    expect(backup.categoryRules.every(rule => rule.source === 'user')).toBe(true);
    expect(backup.transactions[0]).toMatchObject({ categorySource: 'manual', categoryId: null });
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions'), env.DB.prepare('DELETE FROM category_rules')]);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(200);
    const restored = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect(restored.categoryRules).toEqual(backup.categoryRules);
    expect(restored.transactions).toEqual(backup.transactions);
    const effective = (await (await request('/category-rules', 'GET', undefined, headers)).json() as { data: CategoryRuleList }).data.items;
    expect(effective.find(rule => rule.id === builtin.id)?.enabled).toBe(false);
    const retried = await request('/transactions', 'POST', autoInput, { ...headers, 'Idempotency-Key': 'classification-backup-key' });
    expect(retried.status).toBe(200);
    expect((await retried.json() as { data: Transaction }).data).toMatchObject({ id: transaction.id, categorySource: 'manual', categoryId: null });
  });
  it('分类规则冲突使恢复整批回滚，不覆盖当前规则', async () => {
    const { headers } = await seedBackup();
    const created = await request('/category-rules', 'POST', { keyword: '规则备份测试', matchType: 'exact', kind: 'expense', categoryId: 'food', enabled: true }, headers);
    const rule = (await created.json() as { data: CategoryRule }).data;
    const backup = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: CurrentBackup }).data;
    expect((await request(`/category-rules/${rule.id}`, 'PATCH', { ...rule, categoryId: 'leisure' }, headers)).status).toBe(200);
    backup.accounts.push({ id: 'rule-rollback-account', name: '不应写入', bank: '', currency: 'CNY', archived: false });
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(409);
    expect(await env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind('rule-rollback-account').first()).toBeNull();
    expect(await env.DB.prepare('SELECT category_id FROM category_rules WHERE id=?').bind(rule.id).first('category_id')).toBe('leisure');
  });
  it('拒绝缺失分类来源、不一致来源和无效规则引用的v4备份', async () => {
    const { headers, backup } = await seedBackup();
    const missing = { ...backup, transactions: backup.transactions.map(({ categorySource: _, ...transaction }) => transaction) };
    expect((await request('/backup/restore', 'POST', missing, headers)).status).toBe(422);
    const inconsistent = { ...backup, transactions: [{ ...backup.transactions[0], categorySource: 'unclassified' }] };
    expect((await request('/backup/restore', 'POST', inconsistent, headers)).status).toBe(422);
    const invalidRule = { ...backup, categoryRules: [{ id: 'custom-rule-test', keyword: '测试', matchType: 'contains', kind: 'income', categoryId: 'food', enabled: true, source: 'user', version: 1 }] };
    expect((await request('/backup/restore', 'POST', invalidRule, headers)).status).toBe(422);
  });
  it('导出包含业务数据，不含密钥与会话；相同备份重入不重复记账', async () => {
    const { headers, backup } = await seedBackup();
    expect(backup.transactions).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toContain(accessKey); expect(JSON.stringify(backup)).not.toContain('token_hash');
    const restored = await request('/backup/restore', 'POST', backup, headers);
    expect(restored.status).toBe(200);
    expect((await restored.json() as { data: unknown }).data).toEqual({ inserted: 0, skipped: 1, wishlistInserted: 0, wishlistSkipped: 0, budgetRestored: false });
  });
  it('空账本恢复保留金额、来源、版本和撤销状态', async () => {
    const { headers, transaction, backup } = await seedBackup();
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    const result = await request('/backup/restore', 'POST', backup, headers);
    expect(result.status).toBe(200);
    expect((await result.json() as { data: unknown }).data).toEqual({ inserted: 1, skipped: 0, wishlistInserted: 0, wishlistSkipped: 0, budgetRestored: false });
    const restored = (await (await request('/transactions', 'GET', undefined, headers)).json() as { data: { items: Transaction[] } }).data.items[0];
    expect(restored).toEqual(transaction);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transaction_audit').first('COUNT(*)')).toBe(1);
  });
  it('同 ID 不同金额发生冲突时整批回滚，包括新增账户和账目', async () => {
    const { headers, backup } = await seedBackup();
    backup.accounts.push({ id: 'new-account', name: '不应保留', bank: '', currency: 'CNY', archived: false });
    backup.transactions.push({ ...backup.transactions[0], id: 'new-record', accountId: 'new-account' });
    backup.transactions[0].amountCents = 1;
    const result = await request('/backup/restore', 'POST', backup, headers);
    expect(result.status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM accounts WHERE id='new-account'").first('COUNT(*)')).toBe(0);
  });
  it('拒绝损坏的备份和浮点分值，不修改现有数据', async () => {
    const { headers, backup } = await seedBackup();
    backup.transactions[0].amountCents = 12.5;
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(422);
    expect(await env.DB.prepare('SELECT amount_cents FROM transactions').first('amount_cents')).toBe(2019);
  });
  it('恢复后补发原手动请求仍返回原交易 ID，不重复计账', async () => {
    const { headers, transaction, backup } = await seedBackup();
    expect(backup.receipts).toHaveLength(1);
    expect(backup.receipts[0]).toMatchObject({ transactionId: transaction.id, scope: 'manual', key: 'backup-fixture-key' });
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(200);
    const retried = await request('/transactions', 'POST', transactionInput, { ...headers, 'Idempotency-Key': 'backup-fixture-key' });
    expect(retried.status).toBe(200);
    expect((await retried.json() as { data: Transaction }).data.id).toBe(transaction.id);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
  });
  it('请求回执冲突原子回滚，不用备份覆盖现有请求身份', async () => {
    const { headers, backup } = await seedBackup();
    const originalHash = backup.receipts[0].payloadHash;
    backup.accounts.push({ id: 'receipt-account', name: '不应创建的账户', bank: '', currency: 'CNY', archived: false });
    backup.receipts[0].payloadHash = 'f'.repeat(64);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(409);
    expect(await env.DB.prepare('SELECT payload_hash FROM transactions').first('payload_hash')).toBe(originalHash);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM accounts WHERE id='receipt-account'").first('COUNT(*)')).toBe(0);
  });
  it('不同交易占用同一请求标识时拒绝恢复整批', async () => {
    const { headers, backup } = await seedBackup();
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    const replacement = await request('/transactions', 'POST', { ...transactionInput, amount: '50.00' }, { ...headers, 'Idempotency-Key': 'backup-fixture-key' });
    expect(replacement.status).toBe(201);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
    expect(await env.DB.prepare('SELECT amount_cents FROM transactions').first('amount_cents')).toBe(5000);
  });
  it('拒绝无对应账目或重复请求身份的回执', async () => {
    const { headers, backup } = await seedBackup();
    backup.receipts.push({ ...backup.receipts[0], transactionId: 'nonexistent', key: 'missing-transaction' });
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(422);
    backup.receipts[1] = { ...backup.receipts[0] };
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(422);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
  });
  it('来源对象键顺序不造成假冲突，快捷指令恢复后仍能幂等补发', async () => {
    const headers = await login();
    const created = await request('/devices', 'POST', { name: '恢复测试快捷指令', accountId: 'cmb-default' }, headers);
    const { data: { token } } = await created.json() as { data: { token: string } };
    const auth = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'restore-device-key' };
    const body = { amount: '29.80', transaction_time: '2026-11-01T09:00:00+08:00', transaction_type: 'purchase', direction: 'outflow', description: '设备恢复测试', transaction_fingerprint: 'restore-test-fingerprint', currency: 'CNY', bank: '招商银行', parser_version: '1.2.0', balance: '100.01', transaction_time_raw: '11月1日09:00' };
    const accepted = await request('/ingest/cmb', 'POST', body, auth);
    const transactionId = (await accepted.json() as { data: { transactionId: string } }).data.transactionId;
    const backup = (await (await request('/backup', 'GET', undefined, headers)).json() as { data: Backup }).data;
    const reordered = Object.fromEntries(Object.entries(backup.transactions[0].sourceDetails!).reverse());
    await env.DB.prepare('UPDATE transactions SET source_details=? WHERE id=?').bind(JSON.stringify(reordered), transactionId).run();
    const same = await request('/backup/restore', 'POST', backup, headers);
    expect(same.status).toBe(200);
    expect((await same.json() as { data: unknown }).data).toEqual({ inserted: 0, skipped: 1, wishlistInserted: 0, wishlistSkipped: 0, budgetRestored: false });
    await env.DB.batch([env.DB.prepare('DELETE FROM transaction_audit'), env.DB.prepare('DELETE FROM transactions')]);
    expect((await request('/backup/restore', 'POST', backup, headers)).status).toBe(200);
    const retried = await request('/ingest/cmb', 'POST', body, auth);
    expect(retried.status).toBe(200);
    expect((await retried.json() as { data: unknown }).data).toMatchObject({ status: 'duplicate', transactionId });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
  });
});
