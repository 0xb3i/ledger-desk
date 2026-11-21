import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import type { Transaction, TransactionInput } from '../src/shared/contracts';
import { normalizeInput } from '../src/server/ledger/domain';
import { createTransaction } from '../src/server/ledger/repository';

let db: LocalDatabase, env: Env, cookie: string;
const origin = 'https://refund-navigation.test';
const accessKey = `refund-navigation_${'test-key'.repeat(8)}`;
async function request(path: string, authenticated = true, method = 'GET', body?: unknown) {
  return app.request(`${origin}/api${path}`, {
    method,
    headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}
beforeEach(async () => {
  db = new LocalDatabase(':memory:');
  await applyMigrations(db, resolve('migrations'));
  env = { DB: db, OWNER_ACCESS_KEY: accessKey };
  const login = await request('/session', false, 'POST', { accessKey });
  expect(login.status).toBe(200);
  cookie = login.headers.get('Set-Cookie')!.split(';')[0];
});
afterEach(() => db.close());

async function create(kind: 'expense' | 'refund', extra: Partial<TransactionInput> = {}) {
  const input = normalizeInput({
    occurredAt: kind === 'expense' ? '2026-10-31T12:00:00+08:00' : '2026-11-02T12:00:00+08:00',
    kind, amount: '38.90', description: '退款导航测试商户', counterparty: '退款导航测试商户',
    accountId: 'cmb-default', categoryId: kind === 'expense' ? 'food' : null, ...extra,
  });
  return (await createTransaction(db, input, { scope: 'manual', source: 'manual', key: crypto.randomUUID() })).transaction;
}
const pathFor = (refund: Transaction) => `/transactions/${refund.id}/refund-expense`;
async function ledgerSnapshot() {
  return {
    transactions: (await db.prepare('SELECT * FROM transactions ORDER BY id').all()).results,
    audit: (await db.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results,
  };
}

describe('退款详情追溯原支出', () => {
  it('接口需要管理会话；不存在的交易或非退款不能用于追溯', async () => {
    const expense = await create('expense');
    const refund = await create('refund');
    expect((await request(pathFor(refund), false)).status).toBe(401);
    expect((await request('/transactions/missing-refund/refund-expense')).status).toBe(404);
    expect((await request(pathFor(expense))).status).toBe(422);
  });

  it('跨月、分类与分页筛选不会隐藏原支出，返回完整原金额和当前抵扣数据而不写账本', async () => {
    const expense = await create('expense', { note: '应保留的原消费备注', isFixed: true });
    const refund = await create('refund');
    const before = await ledgerSnapshot();
    // The visible refund page has no original expense in its selected month or kind.
    const page = await request('/transactions?month=2026-11&kind=refund&categoryId=uncategorized&pageSize=1');
    expect(page.status).toBe(200);
    const visible = (await page.json() as { data: { items: Transaction[] } }).data.items;
    expect(visible.map(item => item.id)).toEqual([refund.id]);
    const response = await request(pathFor(refund));
    expect(response.status).toBe(200);
    const original = (await response.json() as { data: Transaction }).data;
    expect(original).toMatchObject({
      ...expense,
      refundAdjustment: { refundedCents: 3890, netExpenseCents: 0, refundExpenseId: null },
    });
    expect(await ledgerSnapshot()).toEqual(before);
    expect((await request(pathFor(refund))).status).toBe(200);
    expect(await ledgerSnapshot()).toEqual(before);
  });

  it('部分退款仍能追溯，原消费金额和剩余支出分别保留', async () => {
    const expense = await create('expense', { amount: '100.00' });
    const refund = await create('refund', { amount: '25.00' });
    const response = await request(pathFor(refund));
    expect(response.status).toBe(200);
    expect((await response.json() as { data: Transaction }).data).toMatchObject({
      id: expense.id, amountCents: 10000,
      refundAdjustment: { refundedCents: 2500, netExpenseCents: 7500, refundExpenseId: null },
    });
  });

  it('未匹配和同商户同额歧义不能跳转到猜测的支出', async () => {
    const refund = await create('refund');
    expect((await request(pathFor(refund))).status).toBe(404);
    await create('expense');
    expect((await request(pathFor(refund))).status).toBe(200);
    await create('expense');
    expect((await request(pathFor(refund))).status).toBe(404);
  });

  it.each([
    { side: 'expense', field: 'deleted_at', value: '2026-11-03T12:00:00.000Z' },
    { side: 'expense', field: 'review_status', value: 'pending' },
    { side: 'refund', field: 'deleted_at', value: '2026-11-03T12:00:00.000Z' },
    { side: 'refund', field: 'review_status', value: 'pending' },
  ] as const)('关联任一侧失效即拒绝旧入口：$side $field', async ({ side, field, value }) => {
    const expense = await create('expense');
    const refund = await create('refund');
    expect((await request(pathFor(refund))).status).toBe(200);
    await db.prepare(`UPDATE transactions SET ${field}=?,version=version+1 WHERE id=?`)
      .bind(value, side === 'expense' ? expense.id : refund.id).run();
    const before = await ledgerSnapshot();
    expect((await request(pathFor(refund))).status).toBe(404);
    expect(await ledgerSnapshot()).toEqual(before);
  });
});
