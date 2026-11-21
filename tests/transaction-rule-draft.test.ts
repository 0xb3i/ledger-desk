import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transactionRuleDraft } from '../src/client/components/transactionRuleDraft';
import { defaultCategoryAppearance, type Category, type Transaction, type TransactionInput } from '../src/shared/contracts';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { mapCategory } from '../src/server/ledger/categories';
import { normalizeInput } from '../src/server/ledger/domain';
import { createTransaction, getTransaction, toTransaction } from '../src/server/ledger/repository';
import { createCategoryRule, previewCategoryRuleDraft } from '../src/server/ledger/classification';

const categories: Category[] = [
  { id: 'food', name: '餐饮', kind: 'expense', version: 1, ...defaultCategoryAppearance('food') },
  { id: 'salary', name: '工资', kind: 'income', version: 1, ...defaultCategoryAppearance('salary') },
  { id: 'other', name: '其他', kind: 'both', version: 1, ...defaultCategoryAppearance('other') },
];
function transaction(extra: Partial<Transaction> = {}): Transaction {
  return {
    id: 'source-transaction', occurredAt: '2026-11-15T04:00:00.000Z', kind: 'expense', amountCents: 1900, currency: 'CNY',
    description: '财付通-微信支付-LAWSON上海店', counterparty: 'LAWSON上海店', categoryId: 'food', accountId: 'cmb-default',
    source: 'manual', fingerprint: null, sourceDetails: null, reviewStatus: 'confirmed', note: '',
    createdAt: '2026-11-15T04:00:00.000Z', updatedAt: '2026-11-15T04:00:00.000Z', deletedAt: null,
    version: 1, isFixed: false, transferDirection: null, categorySource: 'manual', categoryRuleId: null, categoryRuleKeyword: null,
    ...extra,
  };
}

describe('从已有账单准备分类规则', () => {
  it.each([
    ['expense', null, 'food', 'expense'],
    ['income', null, 'salary', 'income'],
    ['refund', null, 'food', 'expense'],
    ['transfer', 'inflow', 'salary', 'income'],
    ['transfer', 'outflow', 'food', 'expense'],
  ] as const)('%s / %s 沿用实际资金方向及兼容分类', (kind, transferDirection, categoryId, ruleKind) => {
    const source = transaction({ kind, transferDirection, categoryId });
    const before = structuredClone(source);
    expect(transactionRuleDraft(source, categories, '  LAWSON  ')).toEqual({
      keyword: 'LAWSON', matchType: 'contains', kind: ruleKind, categoryId, enabled: true,
    });
    expect(source).toEqual(before);
  });

  it('已删除账单和未知方向转账不能建规则，不从原始来源猜方向', () => {
    expect(transactionRuleDraft(transaction({ deletedAt: '2026-11-15T05:00:00.000Z' }), categories, 'LAWSON')).toBeNull();
    expect(transactionRuleDraft(transaction({ kind: 'transfer', transferDirection: null,
      sourceDetails: { transactionType: 'transfer', direction: 'inflow', parserVersion: 'test' } }), categories, 'LAWSON')).toBeNull();
  });

  it('通用分类可以沿用，不存在、不兼容或未分类则要求在编辑器选择', () => {
    expect(transactionRuleDraft(transaction({ categoryId: 'other' }), categories)?.categoryId).toBe('other');
    expect(transactionRuleDraft(transaction({ kind: 'income', categoryId: 'other' }), categories)?.categoryId).toBe('other');
    for (const categoryId of ['removed-category', 'salary', null]) {
      expect(transactionRuleDraft(transaction({ categoryId }), categories)?.categoryId).toBe('');
    }
    expect(transactionRuleDraft(transaction({ kind: 'income', categoryId: 'food' }), categories)?.categoryId).toBe('');
  });

  it('显式选词只裁掉两端空白，保留全角、大小写及特殊字符，不截断', () => {
    const text = 'ＬＡＷＳＯＮ &  便利店（%_）';
    expect(transactionRuleDraft(transaction(), categories, `  ${text}\n`)?.keyword).toBe(text);
    expect(transactionRuleDraft(transaction(), categories, '字'.repeat(100))?.keyword).toHaveLength(100);
    for (const keyword of ['', ' \n\t ', '字'.repeat(101)]) {
      expect(transactionRuleDraft(transaction(), categories, keyword)).toBeNull();
    }
  });

  it('缺省使用完整交易对方或摘要，来源过长留空，不抽取平台词或截断', () => {
    expect(transactionRuleDraft(transaction({ counterparty: '  财付通-微信支付-LAWSON  ' }), categories)?.keyword)
      .toBe('财付通-微信支付-LAWSON');
    expect(transactionRuleDraft(transaction({ counterparty: ' \n ' }), categories)?.keyword)
      .toBe('财付通-微信支付-LAWSON上海店');
    expect(transactionRuleDraft(transaction({ counterparty: '字'.repeat(101), description: '短摘要' }), categories)?.keyword).toBe('');
    expect(transactionRuleDraft(transaction({ counterparty: '', description: '字'.repeat(101) }), categories)?.keyword).toBe('');
    expect(transactionRuleDraft(transaction({ counterparty: '', description: '' }), categories)?.keyword).toBe('');
  });
});

describe('规则草稿复用现有预览与分类流程', () => {
  it('选取商户子串可更新历史自动账单并匹配新账，原账单及其他手工分类保持不变', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qingji-rule-draft-'));
    const db = new LocalDatabase(join(directory, 'ledger.sqlite'));
    try {
      await applyMigrations(db, resolve('migrations'));
      const actualCategories = (await db.prepare('SELECT * FROM categories').all()).results.map(mapCategory);
      const create = async (description: string, extra: Partial<TransactionInput> = {}) => (await createTransaction(db,
        normalizeInput({ occurredAt: '2026-11-15T04:00:00.000Z', kind: 'expense', amount: '19.00', description,
          accountId: 'cmb-default', ...extra }),
        { key: crypto.randomUUID(), scope: 'manual', source: 'manual' })).transaction;
      const source = await create('财付通-微信支付-ＬＡＷＳＯＮ上海店', { categoryId: 'food' });
      const historicalUnclassified = await create('支付宝消费', { counterparty: 'Lawson北京店' });
      const historicalAutomatic = await create('LAWSON书店');
      const manual = await create('LAWSON礼品', { categoryId: 'shopping' });
      const manuallyCleared = await create('LAWSON补充消费', { categoryOverride: true });
      expect(historicalUnclassified).toMatchObject({ categoryId: null, categorySource: 'unclassified' });
      expect(historicalAutomatic).toMatchObject({ categoryId: 'learning', categorySource: 'rule' });

      const draft = transactionRuleDraft(source, actualCategories, 'ＬＡＷＳＯＮ');
      expect(draft).not.toBeNull();
      const preview = await previewCategoryRuleDraft(db, draft!);
      expect(preview.changedCount).toBe(2);
      expect(preview.conflictCount).toBe(0);
      expect(new Set(preview.items.map(item => item.transactionId))).toEqual(new Set([historicalUnclassified.id, historicalAutomatic.id]));
      expect(await db.prepare('SELECT COUNT(*) AS count FROM category_rules').first('count')).toBe(0);
      expect(toTransaction(await getTransaction(db, historicalAutomatic.id))).toEqual(historicalAutomatic);

      const rule = await createCategoryRule(db, draft!);
      expect(rule.updatedTransactions).toBe(2);
      for (const original of [historicalUnclassified, historicalAutomatic]) {
        expect(toTransaction(await getTransaction(db, original.id))).toMatchObject({
          categoryId: 'food', categorySource: 'rule', categoryRuleId: rule.id,
          amountCents: original.amountCents, occurredAt: original.occurredAt,
        });
      }
      for (const original of [source, manual, manuallyCleared]) {
        expect(toTransaction(await getTransaction(db, original.id))).toEqual(original);
      }
      expect(await create('财付通-lawson深圳店')).toMatchObject({ categoryId: 'food', categorySource: 'rule', categoryRuleId: rule.id });
      expect(await create('ＬＡＷＳＯＮ退款', { kind: 'refund' })).toMatchObject({ categoryId: 'food', categorySource: 'rule', categoryRuleId: rule.id });
      expect(await create('LAWSON打款', { kind: 'income' })).toMatchObject({ categoryId: null, categorySource: 'unclassified' });
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
