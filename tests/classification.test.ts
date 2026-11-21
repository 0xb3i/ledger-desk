import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { hashPayload, normalizeInput, parseCmb } from '../src/server/ledger/domain';
import { createTransaction, updateTransaction } from '../src/server/ledger/repository';
import { applyCategories, builtinCategoryRules, createCategoryRule, deleteCategoryRule, listCategoryRules, matchCategory, previewCategories, previewCategoryRuleDraft, updateCategoryRule } from '../src/server/ledger/classification';
import { getSummary } from '../src/server/ledger/queries';
import type { CategoryRule, CategoryRuleInput, TransactionInput } from '../src/shared/contracts';

let directory: string, db: LocalDatabase;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'qingji-classification-')); db = new LocalDatabase(join(directory, 'ledger.sqlite')); await applyMigrations(db, resolve('migrations')); });
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
const input = (description: string, extra: Partial<TransactionInput> = {}) => normalizeInput({
  occurredAt: '2026-11-03T12:00:00+08:00', kind: 'expense', amount: '12.30', description, accountId: 'cmb-default', ...extra,
});
const create = (description: string, extra: Partial<TransactionInput> = {}, key: string = crypto.randomUUID()) =>
  createTransaction(db, input(description, extra), { key, scope: 'manual', source: 'manual' });
// A restored legacy rule can exist before history is reconciled.
const restoreRule = (value: CategoryRuleInput = rule()) => db.prepare(`INSERT INTO category_rules(id,keyword,match_type,kind,category_id,enabled,version) VALUES(?,?,?,?,?,?,1)`)
  .bind(crypto.randomUUID(), value.keyword, value.matchType, value.kind, value.categoryId, value.enabled ? 1 : 0).run();
const rule = (extra: Partial<CategoryRuleInput> = {}): CategoryRuleInput => ({ keyword: '测试商户', matchType: 'contains', kind: 'expense', categoryId: 'food', enabled: true, ...extra });

describe('统一分类匹配', () => {
  it('微信转账类型在请求身份之后派生，重试与人工修正不改变原回执', async () => {
    const parsed = parseCmb({ amount: '188.00', transaction_time: '2026-11-01T20:21:00+08:00', transaction_type: 'refund', direction: 'inflow',
      description: '财付通-微信支付-微信转账', transaction_fingerprint: 'wechat-type-fingerprint', currency: 'CNY', bank: '招商银行', parser_version: '1.1.4' }, 'cmb-default');
    const options = { key: 'wechat-original-key', scope: 'shortcut:cmb-default', source: 'shortcut' as const, fingerprint: parsed.fingerprint, sourceDetails: parsed.sourceDetails };
    const expectedHash = await hashPayload({ ...parsed.transaction, source: options.source, fingerprint: options.fingerprint, sourceDetails: options.sourceDetails });
    expect(parsed.transaction.kind).toBe('refund');
    const first = await createTransaction(db, parsed.transaction, options);
    expect(first.transaction).toMatchObject({ kind: 'transfer', transferDirection: 'inflow', amountCents: 18800, categoryId: null, sourceDetails: { transactionType: 'refund', direction: 'inflow' } });
    expect(await db.prepare('SELECT payload_hash FROM transactions WHERE id=?').bind(first.transaction.id).first('payload_hash')).toBe(expectedHash);
    // Simulate a stored pre-fix record, then correct it through the normal edit API.
    await db.prepare("UPDATE transactions SET kind='refund',transfer_direction=NULL,version=version+1 WHERE id=?").bind(first.transaction.id).run();
    const corrected = await updateTransaction(db, first.transaction.id, { ...parsed.transaction, kind: 'transfer', transferDirection: 'inflow', categoryOverride: true }, 2);
    const retried = await createTransaction(db, parsed.transaction, options);
    expect(retried).toEqual({ transaction: corrected, duplicate: true });
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
  });
  it('匹配归一化后的完整主体/摘要，用户规则优先，冲突不靠排序决定', () => {
    const a: CategoryRule = { ...rule({ keyword: 'ＡＢＣ  商户', matchType: 'exact' }), id: 'a', source: 'user', version: 1 };
    const tx = { kind: 'expense' as const, description: '餐饮', counterparty: 'abc\t商户' };
    expect(matchCategory(tx, [...builtinCategoryRules, a])).toMatchObject({ status: 'matched', rule: { id: 'a' } });
    expect(matchCategory({ ...tx, counterparty: 'abc 商户分店' }, [a])).toEqual({ status: 'unmatched' });
    const b: CategoryRule = { ...a, id: 'b', categoryId: 'shopping' };
    expect(matchCategory(tx, [a, b])).toEqual({ status: 'conflict' });
    expect(matchCategory(tx, [b, a])).toEqual({ status: 'conflict' });
    expect(matchCategory(tx, [a, { ...a, id: 'c' }])).toMatchObject({ status: 'matched' });
  });
  it('更具体的关键词优先：包含关系里长的赢，不论来源；互不包含时仍按用户优先与冲突处理', () => {
    const meituan: CategoryRule = { ...rule({ keyword: '美团', categoryId: 'food' }), id: 'u-meituan', source: 'user', version: 1 };
    expect(matchCategory({ kind: 'expense', description: '美团-美团骑行', counterparty: '' }, [...builtinCategoryRules, meituan]))
      .toMatchObject({ status: 'matched', rule: { categoryId: 'transport', keyword: '美团骑行' } });
    expect(matchCategory({ kind: 'expense', description: '美团-美团App喜茶', counterparty: '' }, [...builtinCategoryRules, meituan]))
      .toMatchObject({ status: 'matched', rule: { categoryId: 'food' } });
    const shop: CategoryRule = { ...meituan, id: 'u-shop', keyword: '超市', categoryId: 'shopping' };
    expect(matchCategory({ kind: 'expense', description: '美团超市', counterparty: '' }, [meituan, shop])).toEqual({ status: 'conflict' });
  });
  it('退款沿用支出分类，内部转账不参与；平台名不决定类别', () => {
    expect(matchCategory({ kind: 'refund', description: '商户拼豆退款', counterparty: '' }, builtinCategoryRules)).toMatchObject({ status: 'matched', rule: { categoryId: 'leisure' } });
    expect(matchCategory({ kind: 'transfer', description: '打车', counterparty: '' }, builtinCategoryRules)).toEqual({ status: 'unmatched' });
    for (const description of ['美团', '支付宝', '财付通', '拼多多平台商户', '食品有限公司', '游点逗']) {
      expect(matchCategory({ kind: 'expense', description, counterparty: '' }, builtinCategoryRules)).toEqual({ status: 'unmatched' });
    }
  });
});

describe('规则保存与新账分类', () => {
  it('默认只在代码，首次编辑形成覆盖，停用和删除默认不会复活', async () => {
    expect(await db.prepare('SELECT COUNT(*) FROM category_rules').first('COUNT(*)')).toBe(0);
    const builtin = (await listCategoryRules(db)).find(r => r.keyword === '打车')!;
    const disabled = await updateCategoryRule(db, builtin.id, { ...builtin, enabled: false }, builtin.version);
    expect(disabled).toMatchObject({ source: 'user', version: 2, enabled: false });
    expect((await create('高德打车')).transaction.categoryId).toBeNull();
    await expect(updateCategoryRule(db, builtin.id, builtin, 1)).rejects.toMatchObject({ status: 409 });
    await deleteCategoryRule(db, builtin.id, 2);
    expect((await listCategoryRules(db)).find(r => r.id === builtin.id)?.enabled).toBe(false);
  });
  it('用户规则可删除，规则与类别类型须一致', async () => {
    const created = await createCategoryRule(db, rule());
    await deleteCategoryRule(db, created.id, created.version);
    expect((await listCategoryRules(db)).some(r => r.id === created.id)).toBe(false);
    await expect(createCategoryRule(db, rule({ categoryId: 'salary' }))).rejects.toMatchObject({ status: 422 });
    await expect(createCategoryRule(db, rule({ keyword: '  ' }))).rejects.toBeTruthy();
  });
  it('分类不改变原始回执hash，规则变更后重试返回同一账目的当前分类', async () => {
    const normalized = input('高德打车');
    const expected = await hashPayload({ ...normalized, source: 'manual', fingerprint: null, sourceDetails: null });
    const first = await create('高德打车', {}, 'stable-test-request');
    expect(first.transaction).toMatchObject({ categoryId: 'transport', categorySource: 'rule', categoryRuleKeyword: '打车' });
    expect(await db.prepare('SELECT payload_hash FROM transactions WHERE id=?').bind(first.transaction.id).first('payload_hash')).toBe(expected);
    await createCategoryRule(db, rule({ keyword: '高德', categoryId: 'other' }));
    const retry = await create('高德打车', {}, 'stable-test-request');
    expect(retry.duplicate).toBe(true); expect(retry.transaction).toMatchObject({ id: first.transaction.id, categoryId: 'other', version: 2 });
    expect(await db.prepare('SELECT payload_hash FROM transactions WHERE id=?').bind(first.transaction.id).first('payload_hash')).toBe(expected);
    const next = await create('高德打车'); expect(next.transaction.categoryId).toBe('other');
  });
  it('手工选择和明确留空优先，单改备注不改变分类来源', async () => {
    const automatic = (await create('高德打车')).transaction;
    const note = await updateTransaction(db, automatic.id, input('高德打车', { categoryId: automatic.categoryId, note: '个人备注' }), 1);
    expect(note.categorySource).toBe('rule'); expect(note.categoryRuleId).toBe(automatic.categoryRuleId);
    const cleared = await updateTransaction(db, note.id, input('高德打车', { categoryId: null, categoryOverride: true, note: '个人备注' }), 2);
    expect(cleared).toMatchObject({ categoryId: null, categorySource: 'manual', categoryRuleId: null });
    expect((await previewCategories(db)).matchedCount).toBe(0);
    expect((await create('高德打车', { categoryId: 'other' })).transaction).toMatchObject({ categoryId: 'other', categorySource: 'manual' });
    expect((await create('高德打车', { categoryOverride: true })).transaction).toMatchObject({ categoryId: null, categorySource: 'manual' });
  });
  it('明确操作同一空分类会锁定，categoryOverride=false保持旧输入回执', async () => {
    const created = await create('未知商户', {}, 'same-empty-request');
    expect((await create('未知商户', { categoryOverride: false }, 'same-empty-request')).duplicate).toBe(true);
    await updateTransaction(db, created.transaction.id, input('未知商户', { categoryOverride: true }), 1);
    await createCategoryRule(db, rule({ keyword: '未知商户' }));
    expect((await previewCategories(db)).matchedCount).toBe(0);
  });
  it('修改收支类型即使保留通用分类，也改为手工分类并清除原规则归因', async () => {
    await createCategoryRule(db, rule({ categoryId: 'other' }));
    for (const kind of ['income', 'refund', 'transfer'] as const) {
      const automatic = (await create('测试商户')).transaction;
      expect(automatic).toMatchObject({ categoryId: 'other', categorySource: 'rule' });
      const updated = await updateTransaction(db, automatic.id, input('测试商户', { kind, categoryId: 'other', ...(kind === 'transfer' ? { transferDirection: 'outflow' as const } : {}) }), automatic.version);
      expect(updated).toMatchObject({ kind, categoryId: 'other', categorySource: 'manual', categoryRuleId: null, categoryRuleKeyword: null });
      const audit = await db.prepare('SELECT snapshot FROM transaction_audit WHERE transaction_id=? ORDER BY id DESC LIMIT 1')
        .bind(automatic.id).first<string>('snapshot');
      expect(JSON.parse(audit!)).toMatchObject({ kind, categorySource: 'manual', categoryRuleId: null, categoryRuleKeyword: null });
    }
  });
  it('招行解析原始输出不分类，入库统一分类且同指纹第二条仍待核对', async () => {
    const parsed = parseCmb({ amount: '9.00', transaction_time: '2026-11-03T12:00:00+08:00', transaction_type: 'refund', direction: 'inflow',
      description: '拼豆退费', transaction_fingerprint: 'classification-fingerprint', currency: 'CNY', bank: '招商银行', parser_version: '1.1.4' }, 'cmb-default');
    expect(parsed.transaction.categoryId).toBeNull();
    const a = await createTransaction(db, parsed.transaction, { source: 'shortcut', scope: 'shortcut:cmb-default', key: 'refund-first-key', fingerprint: parsed.fingerprint });
    const b = await createTransaction(db, parsed.transaction, { source: 'shortcut', scope: 'shortcut:cmb-default', key: 'refund-second-key', fingerprint: parsed.fingerprint });
    expect(a.transaction).toMatchObject({ categoryId: 'leisure', kind: 'refund', reviewStatus: 'confirmed' });
    expect(b.transaction).toMatchObject({ categoryId: 'leisure', reviewStatus: 'pending' });
  });
});

describe('历史分类预览与原子应用', () => {
  it('旧库迁移保护手工留空与已编辑分类，并保留原账目、回执、审计和同步检查点', async () => {
    const old = new LocalDatabase(':memory:');
    try {
      for (const name of ['0001_platform.sql', '0002_ledger.sql', '0003_feishu_sync.sql', '0004_fixed_expenses.sql']) {
        const sql = await readFile(resolve('migrations', name), 'utf8');
        old.applyMigration(name, createHash('sha256').update(sql).digest('hex'), sql);
      }
      const timestamp = '2026-11-03T04:00:00.000Z';
      for (const [id, categoryId, version, source] of [
        ['selected', 'other', 1, 'shortcut'], ['edited-empty', null, 2, 'shortcut'],
        ['manual-empty', null, 1, 'manual'], ['shortcut-empty', null, 1, 'shortcut'],
      ] as const) {
        await old.prepare(`INSERT INTO transactions(id,occurred_at,kind,amount_cents,description,category_id,account_id,source,
          version,created_at,updated_at,idempotency_scope,idempotency_key,payload_hash)
          VALUES(?,?,'expense',1230,'高德打车',?,'cmb-default',?,?,?,?,'legacy',?,?)`)
          .bind(id, timestamp, categoryId, source, version, timestamp, timestamp, `legacy-${id}`, `receipt-${id}`).run();
      }
      await old.prepare("INSERT INTO local_feishu_records VALUES('legacy-base','legacy-record','original-source-hash','shortcut-empty')").run();
      const before = (await old.prepare('SELECT * FROM transactions ORDER BY id').all()).results;
      const auditBefore = (await old.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results;
      const checkpoints = (await old.prepare('SELECT * FROM local_feishu_records').all()).results;
      await applyMigrations(old, resolve('migrations'));
      const after = (await old.prepare('SELECT * FROM transactions ORDER BY id').all()).results;
      expect(after.map(({ fixed_auto_excluded: _fixedExclusion, category_source: _source, category_rule_id: _rule, category_rule_keyword: _keyword, transfer_direction: _direction, ...record }) => record)).toEqual(before);
      expect((await old.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results).toEqual(auditBefore);
      const migratedCheckpoints = (await old.prepare('SELECT * FROM local_feishu_records').all()).results;
      expect(migratedCheckpoints.map(({ source_snapshot: _source, pending_snapshot: _pending, ...record }) => record)).toEqual(checkpoints);
      expect(migratedCheckpoints.every(record => record.source_snapshot === null && record.pending_snapshot === null)).toBe(true);
      expect(after.filter(record => record.category_source === 'manual').map(record => record.id)).toEqual(['edited-empty', 'manual-empty', 'selected']);
      expect((await previewCategories(old)).items.map(item => item.transactionId)).toEqual(['shortcut-empty']);
    } finally { old.close(); }
  });
  it('显式重算恢复的规则，保留金额、类型、审核、手工留空及已撤销状态', async () => {
    const one = (await create('测试商户')).transaction;
    await create('测试商户', { categoryOverride: true });
    await create('测试商户', { kind: 'transfer', transferDirection: 'inflow' });
    const removed = (await create('测试商户')).transaction;
    await db.prepare('UPDATE transactions SET deleted_at=?,version=version+1 WHERE id=?').bind(new Date().toISOString(), removed.id).run();
    await create('无信息');
    await restoreRule();
    const before = await getSummary(db, '2026-11');
    const preview = await previewCategories(db);
    expect(preview).toMatchObject({ matchedCount: 1, unmatchedCount: 2, conflictCount: 0 });
    expect(preview.items[0]).toMatchObject({ transactionId: one.id, categoryId: 'food', keyword: '测试商户' });
    expect(await applyCategories(db, preview.snapshot)).toEqual({ updated: 1 });
    const after = await getSummary(db, '2026-11');
    expect(after.expenseCents).toBe(before.expenseCents); expect(after.transferCents).toBe(before.transferCents);
    const rows = (await db.prepare('SELECT id,category_id,category_source FROM transactions').all()).results;
    expect(rows.filter(r => r.category_id === 'food')).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
    await expect(applyCategories(db, preview.snapshot)).rejects.toMatchObject({ status: 409 });
  });
  it('冲突保持未分类，新增账单或更改规则使预览过期', async () => {
    await create('测试商户');
    const a = await createCategoryRule(db, rule());
    await createCategoryRule(db, rule({ categoryId: 'shopping' }));
    const conflict = await previewCategories(db); expect(conflict.conflictCount).toBe(1); expect(conflict.matchedCount).toBe(0);
    await updateCategoryRule(db, a.id, { ...a, enabled: false }, a.version);
    await expect(applyCategories(db, conflict.snapshot)).rejects.toMatchObject({ status: 409 });
    const preview = await previewCategories(db);
    await create('另一笔账');
    await expect(applyCategories(db, preview.snapshot)).rejects.toMatchObject({ code: 'CLASSIFICATION_PREVIEW_STALE' });
  });
  it('预览重新计算后到写入前的并发变更会整批中止', async () => {
    await create('测试商户一'); await create('测试商户二');
    await restoreRule();
    const preview = await previewCategories(db);
    let batches = 0;
    const concurrent = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
      batches++;
      if (batches === 2) await db.prepare("UPDATE transactions SET note='并发用户修改',version=version+1 WHERE description='测试商户二'").run();
      return db.batch(statements);
    } } as unknown as D1Database;
    await expect(applyCategories(concurrent, preview.snapshot)).rejects.toMatchObject({ code: 'CLASSIFICATION_PREVIEW_STALE' });
    expect(await db.prepare('SELECT COUNT(*) FROM transactions WHERE category_id IS NOT NULL').first('COUNT(*)')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
  });
  it('超过单次JSON批量的完整范围仍全部应用', async () => {
    const now = new Date().toISOString();
    await db.batch(Array.from({ length: 205 }, (_, index) => db.prepare(`INSERT INTO transactions(id,occurred_at,kind,amount_cents,description,account_id,source,created_at,updated_at)
      VALUES(?,?,'expense',100,'测试商户','cmb-default','shortcut',?,?)`).bind(`bulk-${index}`, now, now, now)));
    const result = await createCategoryRule(db, rule());
    expect(result.updatedTransactions).toBe(205);
    expect(await db.prepare("SELECT COUNT(*) FROM transactions WHERE category_id='food'").first('COUNT(*)')).toBe(205);
    expect((await previewCategories(db)).matchedCount).toBe(0);
  });
});


describe('规则变更立即重算历史', () => {
  it('创建、修改、启停和删除立即回算历史及退款，并保护人工和财务字段', async () => {
    const ordinary = (await create('测试商户')).transaction;
    const refund = (await create('测试商户', { kind: 'refund' })).transaction;
    await create('测试商户', { categoryId: 'health' });
    await create('测试商户', { categoryOverride: true });
    await create('测试商户', { kind: 'transfer', transferDirection: 'inflow' });
    const removed = (await create('测试商户')).transaction;
    await db.prepare('UPDATE transactions SET deleted_at=?,version=version+1 WHERE id=?').bind(new Date().toISOString(), removed.id).run();
    const financial = async () => (await db.prepare(`SELECT id,occurred_at,kind,amount_cents,description,counterparty,account_id,
      source,fingerprint,source_details,review_status,note,created_at,deleted_at,is_fixed,idempotency_scope,idempotency_key,payload_hash
      FROM transactions ORDER BY id`).all()).results;
    const before = await financial();
    let saved = await createCategoryRule(db, rule());
    expect(saved.updatedTransactions).toBe(2);
    const ids = [ordinary.id, refund.id];
    for (const id of ids) expect(await db.prepare('SELECT category_id,category_source,version FROM transactions WHERE id=?').bind(id).first())
      .toEqual({ category_id: 'food', category_source: 'rule', version: 2 });
    saved = await updateCategoryRule(db, saved.id, { ...saved, categoryId: 'shopping' }, saved.version);
    expect(saved.updatedTransactions).toBe(2);
    saved = await updateCategoryRule(db, saved.id, { ...saved, enabled: false }, saved.version);
    expect(saved.updatedTransactions).toBe(2);
    for (const id of ids) expect(await db.prepare('SELECT category_id,category_source,category_rule_id,category_rule_keyword FROM transactions WHERE id=?').bind(id).first())
      .toEqual({ category_id: null, category_source: 'unclassified', category_rule_id: null, category_rule_keyword: null });
    saved = await updateCategoryRule(db, saved.id, { ...saved, enabled: true }, saved.version);
    expect(saved.updatedTransactions).toBe(2);
    expect(await deleteCategoryRule(db, saved.id, saved.version)).toEqual({ deleted: true, updatedTransactions: 2 });
    expect(await financial()).toEqual(before);
    expect(await db.prepare("SELECT COUNT(*) FROM transactions WHERE category_source='manual'").first('COUNT(*)')).toBe(2);
    for (const id of ids) expect(await db.prepare('SELECT COUNT(*) FROM transaction_audit WHERE transaction_id=?').bind(id).first('COUNT(*)')).toBe(6);
  });
  it('用户规则覆盖旧自动分类，冲突清空；删除冲突规则后自动恢复剩余匹配', async () => {
    const tx = (await create('高德打车')).transaction;
    const a = await createCategoryRule(db, rule({ keyword: '高德', categoryId: 'other' }));
    expect(a.updatedTransactions).toBe(1);
    const b = await createCategoryRule(db, rule({ keyword: '高德', categoryId: 'shopping' }));
    expect(b.updatedTransactions).toBe(1);
    expect(await db.prepare('SELECT category_id,category_source FROM transactions WHERE id=?').bind(tx.id).first()).toEqual({ category_id: null, category_source: 'unclassified' });
    expect((await previewCategories(db)).conflictCount).toBe(1);
    expect((await deleteCategoryRule(db, b.id, b.version)).updatedTransactions).toBe(1);
    expect(await db.prepare('SELECT category_id FROM transactions WHERE id=?').bind(tx.id).first('category_id')).toBe('other');
    expect((await deleteCategoryRule(db, a.id, a.version)).updatedTransactions).toBe(1);
    expect(await db.prepare('SELECT category_id FROM transactions WHERE id=?').bind(tx.id).first('category_id')).toBe('transport');
  });
  it('未改变匹配结果时不重复修改账目版本或审计', async () => {
    const saved = await createCategoryRule(db, rule());
    const tx = (await create('测试商户')).transaction;
    expect((await updateCategoryRule(db, saved.id, saved, saved.version)).updatedTransactions).toBe(0);
    expect((await createCategoryRule(db, rule({ keyword: '无关商户' }))).updatedTransactions).toBe(0);
    expect(await db.prepare('SELECT version FROM transactions WHERE id=?').bind(tx.id).first('version')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) FROM transaction_audit WHERE transaction_id=?').bind(tx.id).first('COUNT(*)')).toBe(1);
  });
  it('保存前发生人工分类时拒绝整批，规则与其他账目均不写入', async () => {
    await create('测试商户一'); const two = (await create('测试商户二')).transaction;
    let batches = 0;
    const concurrent = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
      batches++;
      if (batches === 2) await db.prepare("UPDATE transactions SET category_id='health',category_source='manual',version=version+1 WHERE id=?").bind(two.id).run();
      return db.batch(statements);
    } } as unknown as D1Database;
    await expect(createCategoryRule(concurrent, rule())).rejects.toMatchObject({ code: 'RULE_VERSION_CONFLICT' });
    expect(await db.prepare('SELECT COUNT(*) FROM category_rules').first('COUNT(*)')).toBe(0);
    expect(await db.prepare("SELECT category_id FROM transactions WHERE description='测试商户一'").first('category_id')).toBeNull();
    expect(await db.prepare('SELECT category_id FROM transactions WHERE id=?').bind(two.id).first('category_id')).toBe('health');
    expect(await db.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
  });
  it('历史更新写入失败会回滚规则，允许使用原规则版本再次保存', async () => {
    const saved = await createCategoryRule(db, rule()); await create('测试商户');
    await db.prepare("CREATE TRIGGER deny_history BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'history update failed'); END").run();
    await expect(updateCategoryRule(db, saved.id, { ...saved, categoryId: 'shopping' }, saved.version)).rejects.toThrow('history update failed');
    expect(await db.prepare('SELECT version,category_id FROM category_rules WHERE id=?').bind(saved.id).first()).toEqual({ version: 1, category_id: 'food' });
    expect(await db.prepare('SELECT version,category_id FROM transactions').first()).toEqual({ version: 1, category_id: 'food' });
    await db.prepare('DROP TRIGGER deny_history').run();
    expect((await updateCategoryRule(db, saved.id, { ...saved, categoryId: 'shopping' }, saved.version)).updatedTransactions).toBe(1);
  });
  it('预览包含自动分类的清空与改分类，并显示旧分类', async () => {
    const tx = (await create('高德打车')).transaction;
    // Legacy/backup rule changes can require explicit reconciliation.
    await restoreRule(rule({ keyword: '高德', categoryId: 'shopping' }));
    let preview = await previewCategories(db);
    expect(preview.items[0]).toMatchObject({ transactionId: tx.id, previousCategoryId: 'transport', categoryId: 'shopping' });
    expect(await applyCategories(db, preview.snapshot)).toEqual({ updated: 1 });
    await restoreRule(rule({ keyword: '高德', categoryId: 'food' }));
    preview = await previewCategories(db);
    expect(preview.items[0]).toMatchObject({ transactionId: tx.id, previousCategoryId: 'shopping', categoryId: null, ruleId: null, keyword: null });
    expect(await applyCategories(db, preview.snapshot)).toEqual({ updated: 1 });
    expect(await db.prepare('SELECT category_source FROM transactions WHERE id=?').bind(tx.id).first('category_source')).toBe('unclassified');
  });
});

describe('保存前草稿影响预览', () => {
  it('新规则预览只读，并按保存契约保护手工分类、人工留空及已删除记录', async () => {
    const target = (await create('测试商户')).transaction;
    await create('测试商户', { categoryId: 'health' });
    await create('测试商户', { categoryOverride: true });
    await create('测试商户', { kind: 'income' });
    const removed = (await create('测试商户')).transaction;
    await db.prepare('UPDATE transactions SET deleted_at=?,version=version+1 WHERE id=?').bind(new Date().toISOString(), removed.id).run();
    const readState = async () => Promise.all(['transactions', 'transaction_audit', 'category_rules', 'classification_state', 'restore_guards']
      .map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
    const before = await readState();
    const preview = await previewCategoryRuleDraft(db, rule());
    expect(preview).toMatchObject({ changedCount: 1, conflictCount: 0 });
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({ transactionId: target.id, previousCategoryId: null, categoryId: 'food' });
    expect(await readState()).toEqual(before);
    const saved = await createCategoryRule(db, rule());
    expect(saved.updatedTransactions).toBe(1);
    expect(await db.prepare('SELECT category_id FROM transactions WHERE id=?').bind(target.id).first('category_id')).toBe(preview.items[0].categoryId);
  });
  it('编辑替换原规则，停用回到内置分类；用户规则冲突产生清空预览且不执行', async () => {
    const target = (await create('高德打车')).transaction;
    const saved = await createCategoryRule(db, rule({ keyword: '高德', categoryId: 'shopping' }));
    const editing = { id: saved.id, version: saved.version };
    const modified = await previewCategoryRuleDraft(db, { ...saved, categoryId: 'food' }, editing);
    expect(modified).toMatchObject({ changedCount: 1, conflictCount: 0 });
    expect(modified.items[0]).toMatchObject({ previousCategoryId: 'shopping', categoryId: 'food' });
    const disabled = await previewCategoryRuleDraft(db, { ...saved, enabled: false }, editing);
    expect(disabled.items[0]).toMatchObject({ previousCategoryId: 'shopping', categoryId: 'transport' });
    const conflict = await previewCategoryRuleDraft(db, rule({ keyword: '打车', categoryId: 'food' }));
    expect(conflict).toMatchObject({ changedCount: 1, conflictCount: 1 });
    expect(conflict.items[0]).toMatchObject({ transactionId: target.id, previousCategoryId: 'shopping', categoryId: null });
    expect(await db.prepare('SELECT category_id FROM transactions WHERE id=?').bind(target.id).first('category_id')).toBe('shopping');
    await expect(previewCategoryRuleDraft(db, saved, { ...editing, version: 99 })).rejects.toMatchObject({ status: 409 });
    await expect(previewCategoryRuleDraft(db, saved, { id: 'missing', version: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(previewCategoryRuleDraft(db, { ...saved, categoryId: 'salary' }, editing)).rejects.toMatchObject({ status: 422 });
  });
  it('预览只计可见类目变化，样例有界并按最近时间展示', async () => {
    await createCategoryRule(db, rule());
    await create('测试商户');
    expect(await previewCategoryRuleDraft(db, rule())).toMatchObject({ changedCount: 0, items: [] });
    for (let day = 1; day <= 7; day++) await create(`待分类${day}`, { occurredAt: `2026-11-0${day}T12:00:00+08:00` });
    const preview = await previewCategoryRuleDraft(db, rule({ keyword: '待分类' }));
    expect(preview.changedCount).toBe(7);
    expect(preview.items.map(item => item.description)).toEqual(['待分类7', '待分类6', '待分类5', '待分类4', '待分类3']);
  });
});
