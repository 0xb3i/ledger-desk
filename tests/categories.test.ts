import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { createCategory, updateCategory, listCategories } from '../src/server/ledger/categories';
import { createTransaction } from '../src/server/ledger/repository';
import { normalizeInput } from '../src/server/ledger/domain';
import { createCategoryRule } from '../src/server/ledger/classification';
import { defaultCategoryAppearance, type CategoryInput } from '../src/shared/contracts';
import { app } from '../src/server';
import type { Env } from '../src/server/types';

let directory: string, db: LocalDatabase;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'qingji-categories-')); db = new LocalDatabase(join(directory, 'ledger.sqlite')); await applyMigrations(db, resolve('migrations')); });
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
const categoryInput = (extra: Partial<CategoryInput> = {}): CategoryInput => ({ name: '个人订阅', kind: 'expense', icon: 'laptop', color: 'sage', ...extra });
const transaction = (categoryId: string, kind: 'expense' | 'income' | 'refund' | 'transfer' = 'expense') => createTransaction(db, normalizeInput({
  occurredAt: '2026-11-03T13:00:00+08:00', kind, amount: '12.30', description: '类目验证', accountId: 'cmb-default', categoryId,
}), { source: 'manual', scope: 'manual', key: crypto.randomUUID() });

describe('自定义类目', () => {
  it('迁移按稳定ID补齐图标和颜色，不改账目、回执或审计', async () => {
    const old = new LocalDatabase(':memory:');
    try {
      for (const name of ['0001_platform.sql', '0002_ledger.sql', '0003_feishu_sync.sql', '0004_fixed_expenses.sql', '0005_category_rules.sql']) {
        const sql = await readFile(resolve('migrations', name), 'utf8');
        old.applyMigration(name, createHash('sha256').update(sql).digest('hex'), sql);
      }
      const now = new Date().toISOString();
      await old.prepare(`INSERT INTO transactions(id,occurred_at,kind,amount_cents,description,category_id,account_id,source,created_at,updated_at,idempotency_scope,idempotency_key,payload_hash)
        VALUES('legacy',?,'expense',100,'原账单','food','cmb-default','shortcut',?,?,'shortcut:cmb-default','original-key','original-hash')`).bind(now, now, now).run();
      const before = (await old.prepare('SELECT * FROM transactions').all()).results;
      const audit = (await old.prepare('SELECT * FROM transaction_audit').all()).results;
      await applyMigrations(old, resolve('migrations'));
      expect((await old.prepare('SELECT * FROM transactions').all()).results.map(({ fixed_auto_excluded: _fixedExclusion, transfer_direction: _direction, ...row }) => row)).toEqual(before);
      expect((await old.prepare('SELECT * FROM transaction_audit').all()).results).toEqual(audit);
      for (const category of await listCategories(old)) expect(category).toMatchObject({ ...defaultCategoryAppearance(category.id), version: 1 });
    } finally { old.close(); }
  });
  it('归一化名称并拒绝同名类目，图标与颜色来自固定目录', async () => {
    const first = await createCategory(db, categoryInput({ name: '  ＡＢＣ  订阅  ' }));
    expect(first).toMatchObject({ name: 'ABC 订阅', icon: 'laptop', color: 'sage', version: 1 });
    await expect(createCategory(db, categoryInput({ name: 'abc\t订阅' }))).rejects.toMatchObject({ code: 'CATEGORY_EXISTS', status: 409 });
    await expect(createCategory(db, categoryInput({ name: '未分类' }))).rejects.toBeTruthy();
    await expect(createCategory(db, { ...categoryInput(), icon: 'invalid' } as unknown as CategoryInput)).rejects.toBeTruthy();
    await expect(createCategory(db, { ...categoryInput(), color: '#0000ff' } as unknown as CategoryInput)).rejects.toBeTruthy();
  });
  it('改名及样式保留原ID，不写账目或审计，规则引用继续有效', async () => {
    const category = await createCategory(db, categoryInput());
    await transaction(category.id);
    const rule = await createCategoryRule(db, { keyword: '自定义商户', matchType: 'contains', categoryId: category.id, kind: 'expense', enabled: true });
    const before = (await db.prepare('SELECT * FROM transactions').all()).results, audit = (await db.prepare('SELECT * FROM transaction_audit').all()).results;
    const updated = await updateCategory(db, category.id, { ...category, name: '常用软件', icon: 'smartphone', color: 'amber' }, category.version);
    expect(updated).toMatchObject({ id: category.id, name: '常用软件', icon: 'smartphone', color: 'amber', version: 2 });
    expect((await db.prepare('SELECT * FROM transactions').all()).results).toEqual(before);
    expect((await db.prepare('SELECT * FROM transaction_audit').all()).results).toEqual(audit);
    expect(await db.prepare('SELECT category_id FROM category_rules WHERE id=?').bind(rule.id).first('category_id')).toBe(category.id);
    await expect(updateCategory(db, category.id, category, 1)).rejects.toMatchObject({ status: 409 });
  });
  it('同名编辑不会覆盖其他类目或留下半写入', async () => {
    const first = await createCategory(db, categoryInput({ name: '服务订阅' }));
    const second = await createCategory(db, categoryInput({ name: '软件费用', color: 'amber' }));
    await expect(updateCategory(db, second.id, { ...second, name: first.name, color: 'green' }, second.version)).rejects.toMatchObject({ code: 'CATEGORY_EXISTS' });
    expect((await listCategories(db)).find(category => category.id === second.id)).toEqual(second);
    expect(await db.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
  });
  it('类目范围不能破坏现有账单或规则，允许扩大到通用范围', async () => {
    const category = await createCategory(db, categoryInput({ kind: 'both' }));
    await transaction(category.id, 'expense'); await transaction(category.id, 'income');
    await expect(updateCategory(db, category.id, { ...category, kind: 'expense' }, category.version)).rejects.toMatchObject({ status: 422 });
    expect((await listCategories(db)).find(item => item.id === category.id)?.kind).toBe('both');
    const ruleCategory = await createCategory(db, categoryInput({ name: '自动规则类目', kind: 'both' }));
    await createCategoryRule(db, { keyword: '规则引用', categoryId: ruleCategory.id, kind: 'expense', matchType: 'contains', enabled: false });
    await expect(updateCategory(db, ruleCategory.id, { ...ruleCategory, kind: 'income' }, 1)).rejects.toMatchObject({ status: 422 });
    const unused = await createCategory(db, categoryInput({ name: '无引用' }));
    expect((await updateCategory(db, unused.id, { ...unused, kind: 'income' }, 1)).kind).toBe('income');
  });
  it('数据库约束阻止绕过引用校验，退款沿用支出范围', async () => {
    const category = await createCategory(db, categoryInput());
    await transaction(category.id, 'refund');
    await expect(db.prepare("UPDATE categories SET kind='income' WHERE id=?").bind(category.id).run()).rejects.toThrow('category_kind_reference_conflict');
    await expect(db.prepare("UPDATE transactions SET kind='income' WHERE category_id=?").bind(category.id).run()).rejects.toThrow('transaction_category_kind_conflict');
    await expect(transaction(category.id, 'income')).rejects.toMatchObject({ status: 422 });
  });
  it('并发账单变化使类目编辑原子中止，不覆写最新数据', async () => {
    const category = await createCategory(db, categoryInput());
    let batches = 0;
    const concurrent = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
      if (++batches === 2) await transaction(category.id);
      return db.batch(statements);
    } } as unknown as D1Database;
    await expect(updateCategory(concurrent, category.id, { ...category, name: '不应保存' }, 1)).rejects.toMatchObject({ code: 'CATEGORY_VERSION_CONFLICT' });
    expect((await listCategories(db)).find(item => item.id === category.id)?.name).toBe(category.name);
    expect(await db.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
  });
  it('API需要登录，创建后bootstrap含样式，非法参数和旧版本被拒绝', async () => {
    const origin = 'https://categories.test', env = { DB: db, OWNER_ACCESS_KEY: 'pd_owner_' + 'category-test-key'.repeat(4) } as unknown as Env;
    const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(origin + '/api' + path, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    }, env);
    expect((await request('/categories')).status).toBe(401);
    const login = await request('/session', 'POST', { accessKey: env.OWNER_ACCESS_KEY });
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const created = await request('/categories', 'POST', categoryInput(), cookie);
    expect(created.status).toBe(201);
    const category = (await created.json() as { data: { id: string } }).data;
    const bootstrap = await request('/bootstrap', 'GET', undefined, cookie);
    expect((await bootstrap.json() as { data: { categories: unknown[] } }).data.categories).toContainEqual(expect.objectContaining({ id: category.id, icon: 'laptop', color: 'sage', version: 1 }));
    expect((await request('/categories', 'POST', { ...categoryInput(), icon: 'bad' }, cookie)).status).toBe(422);
    expect((await request('/categories/' + category.id, 'PATCH', { ...categoryInput(), version: 9 }, cookie)).status).toBe(409);
  });
});
