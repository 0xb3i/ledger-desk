import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import type { CategoryDeletionPreview, CategoryInput, CurrentBackup, TransactionInput } from '../src/shared/contracts';
import { createCategory, listCategories, updateCategory } from '../src/server/ledger/categories';
import { deleteCategory, previewCategoryDeletion } from '../src/server/ledger/category-deletion';
import { createCategoryRule, listCategoryRules, updateCategoryRule, previewCategories, applyCategories } from '../src/server/ledger/classification';
import { createTransaction, changeStatus, getTransaction } from '../src/server/ledger/repository';
import { normalizeInput } from '../src/server/ledger/domain';

let db: LocalDatabase;
beforeEach(async () => { db = new LocalDatabase(':memory:'); await applyMigrations(db, resolve('migrations')); });
afterEach(() => db.close());
const category = (name: string, kind: CategoryInput['kind'] = 'expense') => createCategory(db, { name, kind, icon: 'other', color: 'sage' });
const input = (extra: Partial<TransactionInput> = {}) => normalizeInput({
  occurredAt: '2026-11-03T12:00:00+08:00', kind: 'expense', amount: '12.30', description: '分类删除验证',
  accountId: 'cmb-default', ...extra,
});
const record = (extra: Partial<TransactionInput> = {}) => createTransaction(db, input(extra), { source: 'manual', scope: 'manual', key: crypto.randomUUID() });
const rules = () => db.prepare('SELECT * FROM category_rules ORDER BY id').all();
const rows = () => db.prepare('SELECT * FROM transactions ORDER BY id').all();

describe('删除与迁移类目', () => {
  it('无引用类目直接删除，预览只读，不改账单或其他类目', async () => {
    const source = await category('待删空类目');
    const revision = await db.prepare('SELECT revision FROM classification_state').first('revision');
    const preview = await previewCategoryDeletion(db, source.id);
    expect(preview).toMatchObject({ category: source, transactionCount: 0, archivedTransactionCount: 0, ruleCount: 0,
      replacementCategoryId: null, replacements: [] });
    expect(await db.prepare('SELECT revision FROM classification_state').first('revision')).toBe(revision);
    expect(await deleteCategory(db, source.id, preview.snapshot)).toEqual({ deleted: true, movedTransactions: 0, movedRules: 0, updatedTransactions: 0 });
    expect((await listCategories(db)).some(item => item.id === source.id)).toBe(false);
    expect((await rows()).results).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) n FROM restore_guards').first('n')).toBe(0);
  });

  it('预览二级标签和规则的删除影响，并清理手动归入其他的记录', async () => {
    const source = await category('待删标签类目'), target = await category('接收标签类目');
    const { transaction } = await record({ categoryId: source.id });
    await db.prepare("INSERT INTO transaction_tags(transaction_id, category_id, tag_id) VALUES(?,?,NULL)").bind(transaction.id, source.id).run();
    await db.prepare("INSERT INTO tags(id, category_id, name) VALUES('test-tag',?,'待删标签')").bind(source.id).run();
    const previous = await previewCategoryDeletion(db, source.id, target.id);
    expect(previous).toMatchObject({ tagCount: 1, tagRuleCount: 0 });
    await db.prepare("INSERT INTO tag_rules(id, tag_id, keyword) VALUES('test-tag-rule','test-tag','咖啡')").run();
    await expect(deleteCategory(db, source.id, previous.snapshot, target.id)).rejects.toMatchObject({ status: 409 });
    const current = await previewCategoryDeletion(db, source.id, target.id);
    expect(current).toMatchObject({ tagCount: 1, tagRuleCount: 1 });
    await deleteCategory(db, source.id, current.snapshot, target.id);
    expect(await db.prepare('SELECT * FROM transaction_tags WHERE transaction_id=?').bind(transaction.id).first()).toBeNull();
    expect(await db.prepare("SELECT * FROM tag_rules WHERE id='test-tag-rule'").first()).toBeNull();
  });

  it('迁移人工、自动、退款及已删除账单，保留金融字段/回执/checkpoint并保护选择', async () => {
    const source = await category('旧咖啡'), target = await category('新咖啡');
    await createCategoryRule(db, { keyword: '咖啡', matchType: 'contains', kind: 'expense', categoryId: source.id, enabled: true });
    const firstInput = input({ description: '人工咖啡', categoryId: source.id });
    const firstOptions = { source: 'shortcut' as const, scope: 'shortcut:cmb-default', key: crypto.randomUUID(), fingerprint: 'stable-bank-fingerprint' };
    const first = await createTransaction(db, firstInput, firstOptions);
    await record({ description: '自动咖啡' });
    await record({ description: '咖啡退款', kind: 'refund', categoryId: source.id });
    const archived = await record({ description: '归档咖啡' });
    await changeStatus(db, archived.transaction.id, 1, 'archive');
    const cleared = await record({ description: '手动清空咖啡', categoryId: null, categoryOverride: true });
    await db.prepare("INSERT INTO local_feishu_records(source_id,record_id,source_hash,transaction_id) VALUES('source','record','immutable-hash',?)").bind(first.transaction.id).run();
    const before = (await rows()).results;
    const checkpoint = (await db.prepare('SELECT * FROM local_feishu_records').all()).results;
    const auditCount = await db.prepare('SELECT COUNT(*) n FROM transaction_audit').first<number>('n');
    const initial = await previewCategoryDeletion(db, source.id);
    expect(initial).toMatchObject({ transactionCount: 4, archivedTransactionCount: 1, ruleCount: 1, replacements: [] });
    await expect(deleteCategory(db, source.id, initial.snapshot)).rejects.toMatchObject({ status: 422 });
    const preview = await previewCategoryDeletion(db, source.id, target.id);
    expect(preview.replacements).toEqual([{ categoryId: target.id, updatedTransactions: 4 }]);
    expect(await deleteCategory(db, source.id, preview.snapshot, target.id)).toEqual({ deleted: true, movedTransactions: 4, movedRules: 1, updatedTransactions: 4 });
    for (const old of before) {
      const next = await getTransaction(db, String(old.id));
      if (old.id === cleared.transaction.id) { expect(next).toEqual(old); continue; }
      expect(next).toEqual({ ...old, category_id: target.id, category_source: 'manual', category_rule_id: null,
        category_rule_keyword: null, version: Number(old.version) + 1, updated_at: next.updated_at });
    }
    expect((await db.prepare('SELECT * FROM local_feishu_records').all()).results).toEqual(checkpoint);
    expect(await db.prepare('SELECT COUNT(*) n FROM transaction_audit').first('n')).toBe(auditCount! + 4);
    expect((await createTransaction(db, firstInput, firstOptions))).toMatchObject({ duplicate: true, transaction: { id: first.transaction.id, categoryId: target.id } });
    expect((await changeStatus(db, archived.transaction.id, 3, 'restore')).categoryId).toBe(target.id);
    const reclassify = await previewCategories(db); await applyCategories(db, reclassify.snapshot);
    expect((await getTransaction(db, first.transaction.id)).category_id).toBe(target.id);
  });

  it('隐式内置规则也需迁移，已指向其他类目的内置覆盖保持原样', async () => {
    const target = await category('出行');
    const taxi = (await listCategoryRules(db)).find(rule => rule.keyword === '打车')!;
    const { updatedTransactions: _updated, ...overridden } = await updateCategoryRule(db, taxi.id, { ...taxi, categoryId: 'food' }, taxi.version);
    const preview = await previewCategoryDeletion(db, 'transport');
    expect(preview).toMatchObject({ transactionCount: 0, ruleCount: 4 }); // 地铁、停车、美团骑行、美团单车（打车已改指餐饮）
    await expect(deleteCategory(db, 'transport', preview.snapshot)).rejects.toMatchObject({ status: 422 });
    const selected = await previewCategoryDeletion(db, 'transport', target.id);
    await deleteCategory(db, 'transport', selected.snapshot, target.id);
    const current = await listCategoryRules(db);
    expect(current.find(rule => rule.id === taxi.id)).toEqual(overridden);
    expect(current.filter(rule => ['地铁', '停车'].includes(rule.keyword))).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyword: '地铁', categoryId: target.id, source: 'user', version: 2 }),
      expect.objectContaining({ keyword: '停车', categoryId: target.id, source: 'user', version: 2 }),
    ]));
    expect((await record({ description: '地铁' })).transaction.categoryId).toBe(target.id);
    expect((await listCategories(db)).some(item => item.id === 'transport')).toBe(false);
  });

  it('目标预览绑定目标，迁移后重算其他自动账单并保护手工清空', async () => {
    const source = await category('旧饮品'), target = await category('合并饮品');
    await createCategoryRule(db, { keyword: '咖啡', matchType: 'contains', kind: 'expense', categoryId: source.id, enabled: true });
    await createCategoryRule(db, { keyword: '奶茶', matchType: 'contains', kind: 'expense', categoryId: target.id, enabled: true });
    const direct = await record({ description: '咖啡' });
    const conflicting = await record({ description: '咖啡奶茶' });
    const cleared = await record({ description: '咖啡奶茶', categoryOverride: true });
    expect(conflicting.transaction.categoryId).toBe(null);
    const preview = await previewCategoryDeletion(db, source.id, target.id);
    expect(preview.replacements).toEqual([{ categoryId: target.id, updatedTransactions: 2 }]);
    await expect(deleteCategory(db, source.id, preview.snapshot, 'other')).rejects.toMatchObject({ code: 'CATEGORY_VERSION_CONFLICT' });
    expect(await deleteCategory(db, source.id, preview.snapshot, target.id)).toMatchObject({ movedTransactions: 1, updatedTransactions: 2 });
    expect(await getTransaction(db, direct.transaction.id)).toMatchObject({ category_id: target.id, category_source: 'manual' });
    expect(await getTransaction(db, conflicting.transaction.id)).toMatchObject({ category_id: target.id, category_source: 'rule' });
    expect(await getTransaction(db, cleared.transaction.id)).toMatchObject({ category_id: null, category_source: 'manual', version: 1 });
  });

  it('目标必须兼容全部历史引用，包括已删除的收入和方向未知转账', async () => {
    const source = await category('混合类目', 'both');
    await record({ categoryId: source.id });
    const income = await record({ kind: 'income', categoryId: source.id });
    await changeStatus(db, income.transaction.id, 1, 'archive');
    const transfer = await record({ kind: 'transfer', transferDirection: 'inflow', categoryId: source.id });
    await db.prepare('UPDATE transactions SET transfer_direction=NULL,version=version+1 WHERE id=?').bind(transfer.transaction.id).run();
    const preview = await previewCategoryDeletion(db, source.id);
    expect(preview.candidates.map(item => item.id)).toEqual(['other']);
    await expect(previewCategoryDeletion(db, source.id, 'food')).rejects.toMatchObject({ status: 422 });
    const selected = await previewCategoryDeletion(db, source.id, 'other');
    await deleteCategory(db, source.id, selected.snapshot, 'other');
    expect(await getTransaction(db, transfer.transaction.id)).toMatchObject({ category_id: 'other', transfer_direction: null });
  });

  it('并发源/目标/引用变化拒绝过期预览，提交中的并发也不会部分迁移', async () => {
    const source = await category('并发源'), target = await category('并发目标');
    const row = await record({ categoryId: source.id });
    const old = await previewCategoryDeletion(db, source.id, target.id);
    await record({ categoryId: source.id });
    await expect(deleteCategory(db, source.id, old.snapshot, target.id)).rejects.toMatchObject({ code: 'CATEGORY_VERSION_CONFLICT' });
    const beforeRename = await previewCategoryDeletion(db, source.id, target.id);
    await updateCategory(db, source.id, { ...source, name: '源类目已改名' }, source.version);
    await expect(deleteCategory(db, source.id, beforeRename.snapshot, target.id)).rejects.toMatchObject({ code: 'CATEGORY_VERSION_CONFLICT' });
    const preview = await previewCategoryDeletion(db, source.id, target.id);
    let batches = 0;
    const concurrent = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
      if (++batches === 2) await updateCategory(db, target.id, { ...target, name: '用户刚改的名称' }, target.version);
      return db.batch(statements);
    } } as unknown as D1Database;
    await expect(deleteCategory(concurrent, source.id, preview.snapshot, target.id)).rejects.toMatchObject({ code: 'CATEGORY_VERSION_CONFLICT' });
    expect(await getTransaction(db, row.transaction.id)).toMatchObject({ category_id: source.id, version: 1 });
    expect((await listCategories(db)).find(item => item.id === target.id)?.name).toBe('用户刚改的名称');
    expect(await db.prepare('SELECT COUNT(*) n FROM restore_guards').first('n')).toBe(0);
  });

  it('后续删除失败时，已进行的规则迁移和账目审计全部回滚', async () => {
    const source = await category('失败源'), target = await category('失败目标');
    await createCategoryRule(db, { keyword: '迁移验证', matchType: 'contains', kind: 'expense', categoryId: source.id, enabled: false });
    await record({ categoryId: source.id });
    db.applyMigration('test-delete-failure', 'test', "CREATE TRIGGER reject_category_delete BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT,'simulated_constraint_failure'); END;");
    const beforeRows = (await rows()).results, beforeRules = (await rules()).results;
    const beforeAudit = (await db.prepare('SELECT * FROM transaction_audit').all()).results;
    const preview = await previewCategoryDeletion(db, source.id, target.id);
    await expect(deleteCategory(db, source.id, preview.snapshot, target.id)).rejects.toMatchObject({ status: 409 });
    expect((await rows()).results).toEqual(beforeRows); expect((await rules()).results).toEqual(beforeRules);
    expect((await db.prepare('SELECT * FROM transaction_audit').all()).results).toEqual(beforeAudit);
  });

  it('API需登录及同源，迁移后备份可恢复完整类目、规则和幂等身份', async () => {
    const origin = 'https://category-delete.test';
    const env = { DB: db, OWNER_ACCESS_KEY: 'pd_owner_' + 'delete-category-key'.repeat(4) } as unknown as Env;
    const request = (path: string, method = 'GET', body?: unknown, cookie?: string, requestOrigin = origin, database: LocalDatabase = db) => app.request(origin + '/api' + path, {
      method, headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    }, { ...env, DB: database });
    const source = await category('备份源'), target = await category('备份目标');
    await createCategoryRule(db, { keyword: '备份店铺', matchType: 'contains', kind: 'expense', categoryId: source.id, enabled: true });
    const savedInput = input({ description: '备份店铺', categoryId: source.id });
    const options = { source: 'manual' as const, scope: 'manual', key: crypto.randomUUID() };
    const row = await createTransaction(db, savedInput, options);
    expect((await request(`/categories/${source.id}/deletion-preview`)).status).toBe(401);
    expect((await request(`/categories/${source.id}`, 'DELETE', { snapshot: '0'.repeat(64) })).status).toBe(401);
    const login = await request('/session', 'POST', { accessKey: env.OWNER_ACCESS_KEY }); const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const previewResponse = await request(`/categories/${source.id}/deletion-preview?replacementCategoryId=${target.id}`, 'GET', undefined, cookie);
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json() as { data: CategoryDeletionPreview }).data;
    expect(preview).toMatchObject({ category: { id: source.id }, replacementCategoryId: target.id,
      replacements: [{ categoryId: target.id, updatedTransactions: 1 }] });
    const payload = { snapshot: preview.snapshot, replacementCategoryId: target.id };
    expect((await request(`/categories/${source.id}`, 'DELETE', payload, cookie, 'https://wrong.test')).status).toBe(403);
    expect((await request(`/categories/${source.id}`, 'DELETE', payload, cookie)).status).toBe(200);
    const backup = (await (await request('/backup', 'GET', undefined, cookie)).json() as { data: CurrentBackup }).data;
    expect(backup.categories.some(item => item.id === source.id)).toBe(false);
    const restored = new LocalDatabase(':memory:');
    try {
      await applyMigrations(restored, resolve('migrations'));
      const freshLogin = await request('/session', 'POST', { accessKey: env.OWNER_ACCESS_KEY }, undefined, origin, restored);
      const freshCookie = freshLogin.headers.get('Set-Cookie')!.split(';')[0];
      expect((await request('/backup/restore', 'POST', backup, freshCookie, origin, restored)).status).toBe(200);
      expect(await getTransaction(restored, row.transaction.id)).toMatchObject({ category_id: target.id, category_source: 'manual' });
      expect((await listCategoryRules(restored)).some(rule => rule.keyword === '备份店铺' && rule.categoryId === target.id)).toBe(true);
      expect((await createTransaction(restored, savedInput, options))).toMatchObject({ duplicate: true, transaction: { id: row.transaction.id, categoryId: target.id } });
    } finally { restored.close(); }
  });
});
