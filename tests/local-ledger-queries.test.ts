import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionInput } from '../src/shared/contracts';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { hashPayload, normalizeInput } from '../src/server/ledger/domain';
import { changeStatus, createTransaction, updateTransaction } from '../src/server/ledger/repository';
import { spendFilters } from '../src/client/lib/app';
import { getSummary, listTransactions } from '../src/server/ledger/queries';

let db: LocalDatabase;
const migrations = new URL('../migrations/', import.meta.url).pathname;
const base: TransactionInput = {
  occurredAt: '2026-11-01T12:00:00+08:00', kind: 'expense', amount: '1.00',
  description: '筛选内', accountId: 'cmb-default', categoryId: null,
};
async function create(key: string, overrides: Partial<TransactionInput> = {}, pending = false) {
  return (await createTransaction(db, normalizeInput({ ...base, ...overrides }), {
    key, scope: 'manual', source: 'manual', needsReview: pending,
  })).transaction;
}
beforeEach(async () => { db = new LocalDatabase(':memory:'); await applyMigrations(db, migrations); });
afterEach(() => db?.close());

describe('完整筛选范围的账单聚合', () => {
  it('12条分页不截断汇总，收入退款转账分开，排除待核对与撤销记录', async () => {
    for (let amount = 1; amount <= 14; amount++) await create(`paged-expense-${amount}`, { amount: String(amount), isFixed: amount === 14 });
    await create('paged-income', { kind: 'income', amount: '50' });
    await create('paged-refund', { kind: 'refund', amount: '7', description: '筛选内（未关联退款商户）' });
    await create('paged-transfer', { kind: 'transfer', transferDirection: 'outflow', amount: '9' });
    await create('paged-pending', { amount: '40', isFixed: true }, true);
    const archived = await create('paged-archived', { amount: '80', isFixed: true });
    await changeStatus(db, archived.id, archived.version, 'archive');
    await create('other-search', { amount: '500', description: '不匹配搜索' });
    await create('other-month', { amount: '600', occurredAt: '2026-12-01T00:00:00+08:00' });
    const query = { month: '2026-11', search: '筛选内', pageSize: '12', sort: 'largest' };
    const first = await listTransactions(db, query);
    const second = await listTransactions(db, { ...query, page: '2' });
    expect(first).toMatchObject({ total: 18, page: 1, pageSize: 12 });
    expect(first.items).toHaveLength(12); expect(second.items).toHaveLength(6);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(18);
    expect(first.summary).toEqual({ expenseCents: 11400, incomeCents: 5000, refundCents: 700, transferCents: 900,
      grossExpenseCents: 11400, matchedRefundCents: 0, unmatchedRefundCents: 700,
      transferInCents: 0, transferOutCents: 900, unknownTransferCents: 0, transferInCount: 0, transferOutCount: 1, unknownTransferCount: 0,
      expenseCount: 15, incomeCount: 1, refundCount: 1, transferCount: 1, netExpenseCents: 10700, netIncomeCents: -5700 });
    expect(second.summary).toEqual(first.summary);
    expect(second.daily).toEqual([{ date: '2026-11-01', expenseCents: 11400, incomeCents: 5000, refundCents: 700, fixedExpenseCents: 1400 }]);
    const pending = await listTransactions(db, { ...query, status: 'pending' });
    expect(pending.total).toBe(1); expect(Object.values(pending.summary).every(value => value === 0)).toBe(true); expect(pending.daily).toEqual([]);
    const deleted = await listTransactions(db, { ...query, deleted: 'true' });
    expect(deleted.total).toBe(1); expect(Object.values(deleted.summary).every(value => value === 0)).toBe(true); expect(deleted.daily).toEqual([]);
  });

  it('分类支出的下钻笔数和金额与总览一致，区分转出、待核对、收入及全额退款', async () => {
    await db.prepare("UPDATE categories SET kind='both' WHERE id='shopping'").run();
    const buy = await create('drill-buy', { categoryId: 'shopping', amount: '10', description: '部分退货商家' });
    await create('drill-refund', { kind: 'refund', amount: '3', description: '部分退货商家退款' });
    await create('drill-return', { categoryId: 'shopping', amount: '5', description: '全部退货商家' });
    await create('drill-whole', { kind: 'refund', amount: '5', description: '全部退货商家退款' });
    await create('drill-income', { kind: 'income', categoryId: 'shopping' });
    await create('drill-pending', { categoryId: 'shopping' }, true);
    const uncategorized = await create('drill-none');
    const out = await create('drill-out', { kind: 'transfer', transferDirection: 'outflow' });
    await create('drill-in', { kind: 'transfer', transferDirection: 'inflow' });
    const month = '2026-11';
    const { categories } = await getSummary(db, month, new Date('2026-11-03T12:00:00+08:00'));
    for (const [bucket, id, cents] of [['shopping', buy.id, 700], ['transfer', out.id, 100], ['uncategorized', uncategorized.id, 100]] as const) {
      const result = await listTransactions(db, { month, ...spendFilters(bucket) });
      expect(result.items.map(item => item.id)).toEqual([id]);
      expect(result.summary.expenseCents).toBe(cents);
      expect(categories.find(category => (category.categoryId ?? 'uncategorized') === bucket))
        .toMatchObject({ count: result.total, amountCents: cents });
    }
  });

  it('四种排序按完整范围稳定排序，默认每页30，拒绝无效排序与页大小', async () => {
    const oldest = await create('order-oldest', { amount: '20', occurredAt: '2026-11-01T00:00:00+08:00' });
    const middle = await create('order-middle', { amount: '30', occurredAt: '2026-11-02T00:00:00+08:00' });
    const newest = await create('order-newest', { amount: '20', occurredAt: '2026-11-03T00:00:00+08:00' });
    const defaults = await listTransactions(db, {});
    expect(defaults.pageSize).toBe(30); expect(defaults.items.map(item => item.id)).toEqual([newest.id, middle.id, oldest.id]);
    const cases = { oldest: [oldest.id, middle.id, newest.id], largest: [middle.id, newest.id, oldest.id], smallest: [newest.id, oldest.id, middle.id] };
    for (const [sort, expected] of Object.entries(cases)) expect((await listTransactions(db, { sort })).items.map(item => item.id)).toEqual(expected);
    for (const pageSize of ['0', '101', '12.5', '12abc']) await expect(listTransactions(db, { pageSize })).rejects.toMatchObject({ status: 422 });
    await expect(listTransactions(db, { sort: 'amount; DROP TABLE transactions' })).rejects.toMatchObject({ status: 422 });
  });

  it('分类和日期筛选同时约束汇总，UTC边界按北京时间归属', async () => {
    await create('filter-food', { categoryId: 'food', amount: '3', occurredAt: '2026-10-31T16:00:00Z' });
    await create('filter-housing', { categoryId: 'housing', amount: '50' });
    await create('filter-before', { categoryId: 'food', amount: '80', occurredAt: '2026-10-31T15:59:59Z' });
    const result = await listTransactions(db, { categoryId: 'food', date: '2026-11-01' });
    expect(result.total).toBe(1); expect(result.summary.expenseCents).toBe(300);
    expect(result.daily).toEqual([{ date: '2026-11-01', expenseCents: 300, incomeCents: 0, refundCents: 0, fixedExpenseCents: 0 }]);
  });

  it('未分类计数与已确认未分类筛选一致，包含所有类型和人工清空分类', async () => {
    await create('uncategorized-expense');
    await create('uncategorized-income', { kind: 'income' });
    await create('uncategorized-refund', { kind: 'refund' });
    await create('uncategorized-transfer', { kind: 'transfer', transferDirection: 'outflow' });
    const cleared = await create('uncategorized-cleared', { categoryId: 'food' });
    await updateTransaction(db, cleared.id, normalizeInput({ ...base, categoryId: null, categoryOverride: true }), cleared.version);
    await create('uncategorized-pending', {}, true);
    const archived = await create('uncategorized-archived');
    await changeStatus(db, archived.id, archived.version, 'archive');
    await create('uncategorized-other-month', { occurredAt: '2026-12-01T12:00:00+08:00' });
    await create('uncategorized-has-category', { categoryId: 'shopping' });
    const summary = await getSummary(db, '2026-11', new Date('2026-11-03T12:00:00+08:00'));
    const filtered = await listTransactions(db, { month: '2026-11', categoryId: 'uncategorized', status: 'confirmed' });
    expect(summary.uncategorizedCount).toBe(3);
    expect(summary.uncategorizedCount).toBe(filtered.total);
    expect(filtered.items.find(item => item.id === cleared.id)?.categorySource).toBe('manual');
  });
});

describe('日均支出使用已发生的日历天数', () => {
  it('本月两天有消费也按已发生3天计算，排除待核对、撤销和其他交易类型', async () => {
    await create('average-first', { amount: '300.00' });
    await create('average-second', { amount: '83.29', occurredAt: '2026-11-02T12:00:00+08:00' });
    await create('average-fixed', { amount: '120.00', isFixed: true });
    await create('average-pending', { amount: '500.00' }, true);
    const archived = await create('average-archived', { amount: '600.00' });
    await changeStatus(db, archived.id, archived.version, 'archive');
    await create('average-income', { kind: 'income', amount: '700.00' });
    await create('average-refund', { kind: 'refund', amount: '50.00', description: '未关联的退款商户' });
    await create('average-transfer', { kind: 'transfer', transferDirection: 'inflow', amount: '100.00' });
    const summary = await getSummary(db, '2026-11', new Date('2026-11-03T13:00:00+08:00'));
    expect(summary).toMatchObject({ expenseCents: 50329, averageDays: 3, dailyAverageExpenseCents: 12776 });
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily.filter(day => day.expenseCents > 0)).toHaveLength(2);
    const completed = await getSummary(db, '2026-11', new Date('2026-12-01T00:00:00+08:00'));
    expect(completed).toMatchObject({ expenseCents: 50329, averageDays: 30, dailyAverageExpenseCents: 1278 });
  });
  it.each([
    ['2026-10', '2026-10-01T12:00:00+08:00', '31.00', 31],
    ['2027-02', '2027-02-01T12:00:00+08:00', '28.00', 28],
    ['2028-02', '2028-02-01T12:00:00+08:00', '29.00', 29],
  ])('历史月份%s使用实际月天数而非有消费的天数', async (month, occurredAt, amount, expectedDays) => {
    await create(`historical-average-${month}`, { occurredAt, amount });
    const summary = await getSummary(db, month, new Date('2028-03-01T00:00:00+08:00'));
    expect(summary).toMatchObject({ averageDays: expectedDays, dailyAverageExpenseCents: 100 });
    expect(summary.daily).toHaveLength(expectedDays);
  });
  it('未来月份没有日均分母，不能生成虚假的0元日均或除零', async () => {
    await create('future-average', { amount: '10.00', occurredAt: '2026-12-01T12:00:00+08:00' });
    const summary = await getSummary(db, '2026-12', new Date('2026-11-03T13:00:00+08:00'));
    expect(summary).toMatchObject({ expenseCents: 1000, averageDays: 0, dailyAverageExpenseCents: null });
    expect(summary.daily).toHaveLength(31);
  });
  it('本月无消费时以已发生天数计算0元日均', async () => {
    const summary = await getSummary(db, '2026-11', new Date('2026-11-03T13:00:00+08:00'));
    expect(summary).toMatchObject({ expenseCents: 0, averageDays: 3, dailyAverageExpenseCents: 0 });
  });
});

describe('月支出比较的数据范围', () => {
  it('当前月按北京已发生日与上月同期比较，预录未来账目仍留在月汇总中', async () => {
    await create('comparison-previous-in', { amount: '10', occurredAt: '2026-10-03T15:59:59Z' });
    await create('comparison-previous-out', { amount: '80', occurredAt: '2026-10-03T16:00:00Z' });
    await create('comparison-current-in', { amount: '20', occurredAt: '2026-11-03T15:59:59Z' });
    await create('comparison-current-out', { amount: '90', occurredAt: '2026-11-03T16:00:00Z' });
    const summary = await getSummary(db, '2026-11', new Date('2026-11-02T16:00:00Z'));
    expect(summary.expenseCents).toBe(11000);
    expect(summary.previous).toEqual({
      expenseCents: 1000, incomeCents: 0, refundCents: 0,
      month: '2026-10', period: 'same-period', startDate: '2026-10-01', endDate: '2026-10-03',
      currentEndDate: '2026-11-03', currentExpenseCents: 2000, recordCount: 1, currentRecordCount: 1, comparable: true,
      netIncomeCents: -1000, currentIncomeCents: 0, currentNetIncomeCents: -2000,
    });
  });

  it('上月整月有记录但同期无记录时，不推断同期零支出', async () => {
    await create('comparison-later-previous', { amount: '80', occurredAt: '2026-10-31T12:00:00+08:00' });
    await create('comparison-current-only', { amount: '20' });
    const summary = await getSummary(db, '2026-11', new Date('2026-11-03T12:00:00+08:00'));
    expect(summary.previous).toMatchObject({ expenseCents: 0, recordCount: 0, currentRecordCount: 1, comparable: false });
  });

  it('只有已记录收入的月份可比较零支出，区分完全无记录', async () => {
    await create('comparison-previous-income', { kind: 'income', amount: '100', occurredAt: '2026-10-01T12:00:00+08:00' });
    await create('comparison-current-income', { kind: 'income', amount: '50' });
    const summary = await getSummary(db, '2026-11', new Date('2026-11-03T12:00:00+08:00'));
    expect(summary.previous).toMatchObject({ expenseCents: 0, currentExpenseCents: 0, incomeCents: 10000,
      recordCount: 1, currentRecordCount: 1, comparable: true });
  });

  it('没有本月记录时不显示持平或下降，待核对和撤销不充当比较数据', async () => {
    await create('comparison-previous-record', { amount: '10', occurredAt: '2026-10-01T12:00:00+08:00' });
    await create('comparison-current-pending', {}, true);
    const archived = await create('comparison-current-archived');
    await changeStatus(db, archived.id, archived.version, 'archive');
    const summary = await getSummary(db, '2026-11', new Date('2026-11-03T12:00:00+08:00'));
    expect(summary.previous).toMatchObject({ recordCount: 1, currentRecordCount: 0, comparable: false });
    expect(summary.pendingCount).toBe(1);
  });

  it('历史月份比较完整自然月，跨年时保留正确日期范围', async () => {
    await create('comparison-december-last', { amount: '10', occurredAt: '2026-12-31T23:59:59+08:00' });
    await create('comparison-january-last', { amount: '20', occurredAt: '2027-01-31T23:59:59+08:00' });
    const summary = await getSummary(db, '2027-01', new Date('2027-02-03T12:00:00+08:00'));
    expect(summary.previous).toMatchObject({ month: '2026-12', period: 'full-month', startDate: '2026-12-01',
      endDate: '2026-12-31', currentEndDate: '2027-01-31', expenseCents: 1000, currentExpenseCents: 2000, comparable: true });
  });

  it.each([
    ['2027-03', '2027-02-28'],
    ['2028-03', '2028-02-29'],
  ])('当前%s月31日与上月同期比较时截到上月实际月末', async (month, previousLastDay) => {
    await create(`comparison-short-previous-${month}`, { amount: '10', occurredAt: `${previousLastDay}T23:59:59+08:00` });
    await create(`comparison-short-current-${month}`, { amount: '20', occurredAt: `${month}-31T12:00:00+08:00` });
    const summary = await getSummary(db, month, new Date(`${month}-31T12:00:00+08:00`));
    expect(summary.previous).toMatchObject({ period: 'same-period', endDate: previousLastDay, currentEndDate: `${month}-31`,
      expenseCents: 1000, currentExpenseCents: 2000, recordCount: 1, currentRecordCount: 1, comparable: true });
  });

  it('未来月份即使预录账目，也不生成涨跌结论', async () => {
    await create('comparison-future-previous', { amount: '10' });
    await create('comparison-future-current', { amount: '20', occurredAt: '2026-12-01T12:00:00+08:00' });
    const summary = await getSummary(db, '2026-12', new Date('2026-11-03T12:00:00+08:00'));
    expect(summary.previous).toMatchObject({ recordCount: 1, currentRecordCount: 1, comparable: false });
    expect(summary.expenseCents).toBe(2000);
  });
});

describe('收入分类与固定支出', () => {
  it('收入分类来自已确认当月收入，退款不算收入，通用分类按交易类型分开', async () => {
    await create('salary-first', { kind: 'income', amount: '100', categoryId: 'salary' });
    await create('salary-second', { kind: 'income', amount: '200', categoryId: 'salary' });
    await create('income-uncategorized', { kind: 'income', amount: '10' });
    await create('income-other', { kind: 'income', amount: '5', categoryId: 'other' });
    await create('expense-other', { amount: '7', categoryId: 'other' });
    await create('refund-food', { kind: 'refund', amount: '50', categoryId: 'food' });
    await create('transfer-other', { kind: 'transfer', transferDirection: 'outflow', description: '转出给独立收款人', amount: '400', categoryId: 'other' });
    await create('income-pending', { kind: 'income', amount: '700', categoryId: 'salary' }, true);
    const archived = await create('income-archived', { kind: 'income', amount: '900', categoryId: 'salary' });
    await changeStatus(db, archived.id, 1, 'archive');
    await create('income-next-month', { kind: 'income', amount: '600', categoryId: 'salary', occurredAt: '2026-11-30T16:00:00Z' });
    const summary = await getSummary(db, '2026-11');
    expect(summary.incomeCategories).toEqual([
      { categoryId: 'salary', name: '工资', amountCents: 30000, count: 2 },
      { categoryId: null, name: '未分类', amountCents: 1000, count: 1 },
      { categoryId: 'other', name: '其他', amountCents: 500, count: 1 },
    ]);
    expect(summary.categories).toEqual([{ categoryId: 'other', name: '其他', amountCents: 40700, count: 2 }]);
    expect(summary.incomeCents).toBe(31500); expect(summary.refundCents).toBe(5000);
  });

  it('固定标记可编辑并写入审计，只汇总已确认未撤销的固定支出', async () => {
    let fixed = await create('fixed-housing', { amount: '20', isFixed: true, occurredAt: '2026-11-02T00:00:00+08:00' });
    const earlier = await create('fixed-earlier', { amount: '5', isFixed: true });
    await create('ordinary-expense', { amount: '3' });
    await create('fixed-pending', { amount: '99', isFixed: true }, true);
    const archived = await create('fixed-archived', { amount: '88', isFixed: true });
    await changeStatus(db, archived.id, 1, 'archive');
    const summary = await getSummary(db, '2026-11');
    expect(summary.fixedExpenses.map(item => item.id)).toEqual([earlier.id, fixed.id]);
    expect(summary.expenseCents).toBe(2800);
    expect(summary.daily[0]).toMatchObject({ expenseCents: 800, fixedExpenseCents: 500 });
    expect(summary.daily[1]).toMatchObject({ expenseCents: 2000, fixedExpenseCents: 2000 });
    fixed = await updateTransaction(db, fixed.id, normalizeInput({ ...base, amount: '21' }), fixed.version);
    expect(fixed.isFixed).toBe(true);
    const snapshot = await db.prepare('SELECT snapshot FROM transaction_audit WHERE transaction_id=? ORDER BY id DESC LIMIT 1').bind(fixed.id).first<string>('snapshot');
    expect(JSON.parse(snapshot!).isFixed).toBe(true);
    fixed = await updateTransaction(db, fixed.id, normalizeInput({ ...base, isFixed: false }), fixed.version);
    expect(fixed.isFixed).toBe(false);
    fixed = await updateTransaction(db, fixed.id, normalizeInput({ ...base, isFixed: true }), fixed.version);
    fixed = await updateTransaction(db, fixed.id, normalizeInput({ ...base, kind: 'income' }), fixed.version);
    expect(fixed.isFixed).toBe(false);
    for (const kind of ['income', 'refund', 'transfer'] as const) {
      expect(() => normalizeInput({ ...base, kind, isFixed: true })).toThrow('只有支出');
    }
    await expect(db.prepare("UPDATE transactions SET is_fixed=1 WHERE id=?").bind(fixed.id).run()).rejects.toThrow();
  });

  it('旧数据库迁移默认非固定，保留旧审计与幂等哈希，显式false重试仍返回原记录', async () => {
    const old = new LocalDatabase(':memory:');
    try {
      for (const name of ['0001_platform.sql', '0002_ledger.sql', '0003_feishu_sync.sql']) {
        const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
        old.applyMigration(name, createHash('sha256').update(sql).digest('hex'), sql);
      }
      const timestamp = '2026-11-01T04:00:00.000Z';
      const hash = await hashPayload({ occurredAt: timestamp, kind: 'expense', amountCents: 100,
        description: '筛选内', counterparty: '', categoryId: null, accountId: 'cmb-default', note: '',
        source: 'manual', fingerprint: null, sourceDetails: null });
      await old.prepare(`INSERT INTO transactions(id,occurred_at,kind,amount_cents,description,account_id,source,created_at,updated_at,idempotency_scope,idempotency_key,payload_hash)
        VALUES('legacy-row',?,'expense',100,'筛选内','cmb-default','manual',?,?,'manual','legacy-retry-key',?)`).bind(timestamp, timestamp, timestamp, hash).run();
      const auditBefore = await old.prepare('SELECT snapshot FROM transaction_audit').first('snapshot');
      await applyMigrations(old, migrations);
      expect(await old.prepare('SELECT is_fixed FROM transactions').first('is_fixed')).toBe(0);
      expect(await old.prepare('SELECT snapshot FROM transaction_audit').first('snapshot')).toBe(auditBefore);
      const replay = await createTransaction(old, normalizeInput({ ...base, isFixed: false }), { key: 'legacy-retry-key', scope: 'manual', source: 'manual' });
      expect(replay.duplicate).toBe(true); expect(replay.transaction).toMatchObject({ id: 'legacy-row', isFixed: false });
      await expect(createTransaction(old, normalizeInput({ ...base, isFixed: true }), { key: 'legacy-retry-key', scope: 'manual', source: 'manual' })).rejects.toMatchObject({ status: 409 });
      expect(await old.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
    } finally { old.close(); }
  });

  it('同额固定支出分别保留各自商户和分类，共用别名时跳过自动识别', async () => {
    const common = { amount: '30', counterparty: '共同代扣平台', isFixed: true };
    const video = await create('fixed-video', { ...common, description: '影音订阅甲', categoryId: 'leisure' });
    const phone = await create('fixed-phone', { ...common, description: '手机套餐乙', categoryId: 'other' });
    const ambiguous = await create('fixed-ambiguous', { description: '共同代扣平台', amount: '30' });
    const recurring = await create('fixed-video-next', { description: '影音订阅甲', amount: '30' });
    const items = (await listTransactions(db, {})).items;
    expect(items.find(row => row.id === video.id)).toMatchObject({ description: '影音订阅甲', categoryId: 'leisure', version: 1 });
    expect(items.find(row => row.id === phone.id)).toMatchObject({ description: '手机套餐乙', categoryId: 'other', version: 1 });
    expect(ambiguous.isFixed).toBe(false);
    expect(recurring).toMatchObject({ isFixed: true, description: '影音订阅甲', categoryId: 'leisure' });
  });

  it('编辑固定项仅向原商户信息、金额与分类一致的历史固定项同步', async () => {
    const original = { description: '影音订阅甲', counterparty: '共同代扣平台', amount: '30', categoryId: 'leisure', isFixed: true };
    const previous = await create('fixed-peer-last', { ...original, occurredAt: '2026-10-01T12:00:00+08:00' });
    const current = await create('fixed-peer-this', original);
    const unrelated = await create('fixed-peer-other', { ...original, description: '手机套餐乙' });
    const separate = await create('fixed-peer-category', { ...original, categoryId: 'learning' });
    const edit = normalizeInput({ ...base, ...original, description: '影音月费', categoryId: 'other', categoryOverride: true });
    await expect(updateTransaction(db, current.id, edit, current.version + 1)).rejects.toMatchObject({ status: 409 });
    expect((await listTransactions(db, {})).items.find(row => row.id === previous.id)?.version).toBe(1);
    await updateTransaction(db, current.id, edit, current.version);
    const items = (await listTransactions(db, {})).items;
    expect(items.find(row => row.id === previous.id)).toMatchObject({ description: '影音月费', categoryId: 'other', version: 2 });
    expect(items.find(row => row.id === unrelated.id)).toMatchObject({ description: '手机套餐乙', categoryId: 'leisure', version: 1 });
    expect(items.find(row => row.id === separate.id)).toMatchObject({ description: '影音订阅甲', categoryId: 'learning', version: 1 });
  });

  it('按曾用名/交易对方+相同金额跨月自动同步历史与新增固定支出', async () => {
    const octRent = await create('oct-rent', {
      occurredAt: '2026-10-12T10:00:00+08:00',
      kind: 'transfer',
      transferDirection: 'outflow',
      amount: '3200.00',
      description: '财付通-微信支付-微信转账',
      counterparty: '财付通-微信支付-微信转账',
    });
    const octOtherTransfer = await create('oct-other-transfer', {
      occurredAt: '2026-10-13T10:00:00+08:00',
      kind: 'transfer',
      transferDirection: 'outflow',
      amount: '50.00',
      description: '财付通-微信支付-微信转账',
      counterparty: '财付通-微信支付-微信转账',
    });
    const novRent = await create('nov-rent', {
      occurredAt: '2026-11-12T10:00:00+08:00',
      kind: 'transfer',
      transferDirection: 'outflow',
      amount: '3200.00',
      description: '财付通-微信支付-微信转账',
      counterparty: '财付通-微信支付-微信转账',
    });

    // 用户将 11 月的这笔改名为“房租”、设为支出、归入“居住”并开启固定支出
    await updateTransaction(db, novRent.id, normalizeInput({
      ...base,
      occurredAt: novRent.occurredAt,
      kind: 'expense',
      amount: '3200.00',
      description: '房租',
      counterparty: novRent.counterparty,
      categoryId: 'housing',
      categoryOverride: true,
      isFixed: true,
    }), novRent.version);

    // 10 月同金额、同曾用名的账单自动同步为固定支出“房租”，而不同金额的微信转账不受影响
    const octSummary = await getSummary(db, '2026-10');
    expect(octSummary.fixedExpenses).toHaveLength(1);
    expect(octSummary.fixedExpenses[0]).toMatchObject({
      id: octRent.id,
      kind: 'expense',
      isFixed: true,
      description: '房租',
      counterparty: '财付通-微信支付-微信转账',
      categoryId: 'housing',
      amountCents: 320000,
    });
    const untouched = (await listTransactions(db, { month: '2026-10', kind: 'transfer' })).items;
    expect(untouched).toHaveLength(1);
    expect(untouched[0].id).toBe(octOtherTransfer.id);

    // 12 月新同步进来的同金额原始名称账单直接自动识别为固定支出“房租”
    const decRent = await create('dec-rent', {
      occurredAt: '2026-12-12T10:00:00+08:00',
      kind: 'transfer',
      transferDirection: 'outflow',
      amount: '3200.00',
      description: '财付通-微信支付-微信转账',
      counterparty: '财付通-微信支付-微信转账',
    });
    expect(decRent).toMatchObject({
      kind: 'expense',
      isFixed: true,
      description: '房租',
      counterparty: '财付通-微信支付-微信转账',
      categoryId: 'housing',
      amountCents: 320000,
    });
    const restoredName = '这笔单独计入日均';
    const currentOctRent = (await listTransactions(db, { month: '2026-10', kind: 'expense' })).items.find(item => item.id === octRent.id)!;
    const cancelled = await updateTransaction(db, octRent.id, normalizeInput({ ...base,
      occurredAt: octRent.occurredAt, amount: '3200.00', description: restoredName,
      counterparty: currentOctRent.counterparty, categoryId: 'housing', isFixed: false,
    }), currentOctRent.version);
    await create('fixed-unrelated', { amount: '15.00', description: '其他商户' });
    expect((await listTransactions(db, { month: '2026-10', kind: 'expense' })).items.find(item => item.id === octRent.id))
      .toMatchObject({ description: restoredName, isFixed: false, version: cancelled.version });
    expect((await getSummary(db, '2026-10')).fixedExpenses).toEqual([]);
  });
});
