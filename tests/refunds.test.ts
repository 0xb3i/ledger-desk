import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { normalizeInput } from '../src/server/ledger/domain';
import { createTransaction, type TransactionRow } from '../src/server/ledger/repository';
import { getSummary, listTransactions } from '../src/server/ledger/queries';
import { matchRefunds } from '../src/server/ledger/refunds';
import type { TransactionInput } from '../src/shared/contracts';

let db: LocalDatabase;
beforeEach(async () => { db = new LocalDatabase(':memory:'); await applyMigrations(db, new URL('../migrations/', import.meta.url).pathname); });
afterEach(() => db.close());
async function create(description: string, amount: string, kind: 'expense' | 'refund' = 'expense', options: Partial<TransactionInput> = {}) {
  return (await createTransaction(db, normalizeInput({ occurredAt: kind === 'expense' ? '2026-11-01T12:00:00+08:00' : '2026-11-02T12:00:00+08:00',
    description, counterparty: description, amount, kind, accountId: 'cmb-default', categoryId: kind === 'expense' ? 'food' : null, ...options }),
    { key: crypto.randomUUID(), scope: 'manual', source: 'manual' })).transaction;
}
async function rows() { return (await db.prepare('SELECT * FROM transactions ORDER BY id').all()).results as unknown as TransactionRow[]; }
const now = new Date('2026-11-03T12:00:00+08:00');

describe('退款关联与支出统计投影', () => {
  it('完整退款和长摘要截断匹配，支出/分类/日均统一抵扣，原记录和审计不改', async () => {
    const full = '美团-美团App拼好豆团建DIY拼豆（安庆吾悦店）';
    await create('美团-美团App窝趣DIY拼豆手作', '38.90', 'expense', { categoryId: 'leisure' });
    await create('美团-美团App窝趣DIY拼豆手作', '38.90', 'refund');
    await create('美团-美团App拼好豆团建DIY拼豆（…', '32.80', 'expense', { categoryId: 'leisure' });
    await create(full, '32.80', 'refund');
    await create('其余真实消费商户', '311.59');
    const before = await rows(), audit = (await db.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results;
    const summary = await getSummary(db, '2026-11', now);
    expect(summary).toMatchObject({ expenseCents: 31159, grossExpenseCents: 38329, matchedRefundCents: 7170, unmatchedRefundCents: 0,
      refundCents: 7170, netExpenseCents: 31159, netIncomeCents: -31159, dailyAverageExpenseCents: 10386 });
    expect(summary.categories).toEqual([{ categoryId: 'food', name: '餐饮', amountCents: 31159, count: 1 }]);
    expect(summary.daily[0].expenseCents).toBe(31159);
    const page = await listTransactions(db, { month: '2026-11' });
    expect(page.summary.expenseCount).toBe(1);
    expect(page.items.filter(item => item.kind === 'expense' && item.refundAdjustment?.netExpenseCents === 0)).toHaveLength(2);
    expect(page.items.filter(item => item.kind === 'refund' && item.refundAdjustment?.refundExpenseId)).toHaveLength(2);
    expect(await rows()).toEqual(before);
    expect((await db.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results).toEqual(audit);
  });
  it('部分退款可合并但总额不能超过原支出，不按日期顺序挑一笔超额退款', async () => {
    const expense = await create('退款测试商户甲', '100.00');
    await create('退款测试商户甲退款', '30.00', 'refund');
    await create('退款测试商户甲退费', '20.00', 'refund');
    expect(matchRefunds(await rows()).get(expense.id)).toMatchObject({ refundedCents: 5000, netExpenseCents: 5000 });
    await create('退款测试商户甲', '60.00', 'refund');
    expect(matchRefunds(await rows()).size).toBe(0);
    expect(await getSummary(db, '2026-11', now)).toMatchObject({ expenseCents: 10000, matchedRefundCents: 0, unmatchedRefundCents: 11000 });
  });
  it('同商户多笔消费时金额完全相符优先；重复同额候选不自动配对', async () => {
    const exact = await create('商户唯一金额', '30.00');
    await create('商户唯一金额', '100.00');
    const refund = await create('商户唯一金额', '30.00', 'refund');
    expect(matchRefunds(await rows()).get(refund.id)?.refundExpenseId).toBe(exact.id);
    await create('商户唯一金额', '30.00');
    expect(matchRefunds(await rows()).size).toBe(0);
  });
  it('仅平台名、短截断、不同账户、早于消费及超过90天的退款均不能抵扣', async () => {
    await db.prepare("INSERT INTO accounts(id,name,bank) VALUES('account-other','另一个测试账户','')").run();
    await create('美团', '10'); await create('美团', '10', 'refund');
    await create('财付通-微信支付', '10'); await create('财付通-微信支付', '10', 'refund');
    await create('餐厅…', '10'); await create('餐厅A完整名称', '10', 'refund');
    await create('不同账户商户', '10'); await create('不同账户商户', '10', 'refund', { accountId: 'account-other' });
    await create('时间边界商户', '10'); await create('时间边界商户', '10', 'refund', { occurredAt: '2026-10-30T12:00:00+08:00' });
    await create('长期退款商户', '10'); await create('长期退款商户', '10', 'refund', { occurredAt: '2027-03-01T12:00:00+08:00' });
    expect(matchRefunds(await rows()).size).toBe(0);
  });
  it('90天窗口边界包含当天时间点，超出一毫秒不进入候选', async () => {
    const expense = await create('精确时间边界商户', '10');
    const boundary = Date.parse(expense.occurredAt) + 90 * 86400000;
    const included = await create('精确时间边界商户', '10', 'refund', { occurredAt: new Date(boundary).toISOString() });
    const excluded = await create('精确时间边界商户', '10', 'refund', { occurredAt: new Date(boundary + 1).toISOString() });
    const adjustments = matchRefunds(await rows());
    expect(adjustments.get(included.id)?.refundExpenseId).toBe(expense.id);
    expect(adjustments.has(excluded.id)).toBe(false);
  });
  it('待核对、删除任一侧或转账类型不参与匹配，恢复后可重新计算', async () => {
    const expense = await create('状态测试商户', '10'); const refund = await create('状态测试商户', '10', 'refund');
    expect(matchRefunds(await rows()).size).toBe(2);
    for (const [column, value] of [['review_status', 'pending'], ['deleted_at', '2026-11-03T00:00:00.000Z'], ['kind', 'transfer']] as const) {
      await db.prepare(`UPDATE transactions SET ${column}=? WHERE id=?`).bind(value, refund.id).run();
      expect(matchRefunds(await rows()).size).toBe(0);
      await db.prepare("UPDATE transactions SET review_status='confirmed',deleted_at=NULL,kind='refund' WHERE id=?").bind(refund.id).run();
    }
    await db.prepare("UPDATE transactions SET deleted_at='2026-11-03T00:00:00.000Z' WHERE id=?").bind(expense.id).run();
    expect(matchRefunds(await rows()).size).toBe(0);
  });
  it('跨月退款抵扣原消费月份，现金结余保留实际发生月且不重复抵扣', async () => {
    await create('跨月固定商户', '100', 'expense', { occurredAt: '2026-10-31T23:59:59+08:00', isFixed: true });
    await create('跨月固定商户', '40', 'refund');
    const october = await getSummary(db, '2026-10', now), november = await getSummary(db, '2026-11', new Date('2026-12-01T00:00:00+08:00'));
    expect(october).toMatchObject({ expenseCents: 6000, grossExpenseCents: 10000, matchedRefundCents: 4000, refundCents: 0, netIncomeCents: -10000 });
    expect(october.daily[30]).toMatchObject({ expenseCents: 6000, fixedExpenseCents: 6000 });
    expect(october.fixedExpenses[0]).toMatchObject({ amountCents: 10000, refundAdjustment: { netExpenseCents: 6000 } });
    expect(november).toMatchObject({ expenseCents: 0, matchedRefundCents: 0, unmatchedRefundCents: 0, refundCents: 4000, netIncomeCents: 4000, previous: { expenseCents: 6000 } });
  });
  it('筛选与分页不会隐藏配对侧，完整汇总与原金额排序保持一致', async () => {
    for (let index = 0; index < 15; index++) await create(`独立消费商户${index}`, '10');
    const expense = await create('唯一搜索商户', '99', 'expense', { isFixed: true });
    await create('唯一搜索商户退款', '99', 'refund');
    const first = await listTransactions(db, { month: '2026-11', kind: 'expense', pageSize: '12', sort: 'largest' });
    const second = await listTransactions(db, { month: '2026-11', kind: 'expense', pageSize: '12', sort: 'largest', page: '2' });
    expect(first.total).toBe(16); expect(first.items[0].id).toBe(expense.id);
    expect(first.summary).toMatchObject({ expenseCents: 15000, grossExpenseCents: 24900, matchedRefundCents: 9900, expenseCount: 15 });
    expect(second.summary).toEqual(first.summary);
    const search = await listTransactions(db, { search: '唯一搜索商户', kind: 'expense' });
    expect(search.summary.expenseCents).toBe(0);
    expect(search.items[0].amountCents).toBe(9900);
    expect(search.items[0].refundAdjustment?.netExpenseCents).toBe(0);
    expect((await getSummary(db, '2026-11', now)).fixedExpenses).toEqual([]);
  });
  it('退款描述与主体可归一化，但重复退款总额超限不被静默接受', async () => {
    const expense = await create('支付宝-ＡＢＣ  商户', '20');
    const refund = await create('支付宝－abc 商户退款。', '20', 'refund');
    expect(matchRefunds(await rows()).get(refund.id)?.refundExpenseId).toBe(expense.id);
    await create('支付宝-abc 商户', '20', 'refund');
    expect(matchRefunds(await rows()).size).toBe(0);
  });

  it.each([['100', '110'], ['110', '100']])('两笔支出 %s / %s 争用同一拆单退款时保持未匹配', async (first, second) => {
    await create('拆单商户', first);
    await create('拆单商户', second, 'expense', { occurredAt: '2026-11-01T14:00:00+08:00' });
    for (const amount of ['60', '40', '50']) await create('拆单商户', amount, 'refund');
    expect(matchRefunds(await rows()).size).toBe(0);
    expect(await getSummary(db, '2026-11', now)).toMatchObject({ expenseCents: 21000, unmatchedRefundCents: 15000 });
  });

  it('同商户多笔合单消费按子订单拆分退款时，通过唯一余额子集精确配对抵扣', async () => {
    const e1 = await create('支付宝-温州森生向上科技有限公司', '165.99', 'expense', { occurredAt: '2026-11-06T18:12:00+08:00' });
    await create('支付宝-温州森生向上科技有限公司', '125.59', 'refund', { occurredAt: '2026-11-06T18:14:00+08:00' });
    const e2 = await create('支付宝-温州森生向上科技有限公司', '169.87', 'expense', { occurredAt: '2026-11-06T18:15:00+08:00' });
    await create('支付宝-温州森生向上科技有限公司', '13.50', 'refund', { occurredAt: '2026-11-06T18:15:00+08:00' });
    await create('支付宝-温州森生向上科技有限公司', '26.90', 'refund', { occurredAt: '2026-11-06T18:15:00+08:00' });
    await create('支付宝-温州森生向上科技有限公司', '129.09', 'refund', { occurredAt: '2026-11-06T18:18:00+08:00' });
    await create('支付宝-温州森生向上科技有限公司', '40.78', 'refund', { occurredAt: '2026-11-06T18:18:00+08:00' });

    const adjustments = matchRefunds(await rows());
    expect(adjustments.get(e1.id)).toMatchObject({ refundedCents: 16599, netExpenseCents: 0 });
    expect(adjustments.get(e2.id)).toMatchObject({ refundedCents: 16987, netExpenseCents: 0 });
    const summary = await getSummary(db, '2026-11', new Date('2026-11-20T12:00:00+08:00'));
    expect(summary).toMatchObject({
      expenseCents: 0,
      grossExpenseCents: 33586,
      matchedRefundCents: 33586,
      unmatchedRefundCents: 0,
      netIncomeCents: 0,
    });
  });
});
