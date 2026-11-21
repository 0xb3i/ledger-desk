import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import { getTransactionCashflowKind, type CurrentBackup, type TransactionInput } from '../src/shared/contracts';
import { hashPayload, normalizeInput, parseCmb } from '../src/server/ledger/domain';
import { createTransaction, updateTransaction } from '../src/server/ledger/repository';
import { getSummary, listTransactions } from '../src/server/ledger/queries';
import { createCategoryRule } from '../src/server/ledger/classification';

let db: LocalDatabase;
beforeEach(async () => { db = new LocalDatabase(':memory:'); await applyMigrations(db, resolve('migrations')); });
afterEach(() => db.close());
const base: TransactionInput = { occurredAt: '2026-11-01T12:00:00+08:00', kind: 'expense', amount: '100.00', description: '隔离转账统计商户', accountId: 'cmb-default', categoryId: null };
const now = new Date('2026-11-03T12:00:00+08:00');
const create = (extra: Partial<TransactionInput> = {}, key = crypto.randomUUID()) => createTransaction(db, normalizeInput({ ...base, ...extra }), { key, scope: 'manual', source: 'manual' });

describe('单账户转账资金方向', () => {
  it('AA消费100、回款提现50体现收入50和结余减少50，不增加虚构交易', async () => {
    await create({ description: 'AA餐饮', categoryId: 'food' });
    const parsed = parseCmb({ amount: '50.00', transaction_time: '2026-11-02T12:00:00+08:00', transaction_type: 'wallet_withdrawal', direction: 'inflow',
      description: 'AA回款微信零钱提现', transaction_fingerprint: 'aa-transfer-test-fingerprint', currency: 'CNY', bank: '招商银行', parser_version: '1.1.5' }, 'cmb-default');
    const options = { key: 'aa-bank-transfer-key', scope: 'shortcut:cmb-default', source: 'shortcut' as const, fingerprint: parsed.fingerprint, sourceDetails: parsed.sourceDetails };
    const originalHash = await hashPayload({ ...parsed.transaction, source: options.source, fingerprint: options.fingerprint, sourceDetails: options.sourceDetails });
    const accepted = await createTransaction(db, parsed.transaction, options);
    expect(accepted.transaction).toMatchObject({ kind: 'transfer', transferDirection: 'inflow', amountCents: 5000 });
    expect(await getSummary(db, '2026-11', now)).toMatchObject({ expenseCents: 10000, grossExpenseCents: 10000, incomeCents: 5000,
      transferInCents: 5000, transferOutCents: 0, netIncomeCents: -5000, count: 2 });
    const incoming = await listTransactions(db, { month: '2026-11', kind: 'income' });
    expect(incoming.total).toBe(1); expect(incoming.items[0].id).toBe(accepted.transaction.id);
    expect(incoming.summary).toMatchObject({ incomeCents: 5000, incomeCount: 1, transferInCount: 1 });
    expect(incoming.daily[0].incomeCents).toBe(5000);
    expect((await listTransactions(db, { kind: 'expense' })).total).toBe(1);
    expect(await db.prepare('SELECT payload_hash FROM transactions WHERE id=?').bind(accepted.transaction.id).first('payload_hash')).toBe(originalHash);
    expect((await createTransaction(db, parsed.transaction, options)).duplicate).toBe(true);
  });
  it('转出算支出，匹配退款仅抵扣一次，分类、每日和日均保持一致', async () => {
    const outgoing = (await create({ kind: 'transfer', transferDirection: 'outflow', description: '转出退费独立商户', categoryId: 'shopping' })).transaction;
    await create({ kind: 'refund', amount: '20.00', occurredAt: '2026-11-02T12:00:00+08:00', description: '转出退费独立商户退款' });
    const summary = await getSummary(db, '2026-11', now);
    expect(summary).toMatchObject({ expenseCents: 8000, grossExpenseCents: 10000, matchedRefundCents: 2000, transferOutCents: 10000,
      netIncomeCents: -8000, dailyAverageExpenseCents: 2667 });
    expect(summary.categories).toEqual([{ categoryId: 'shopping', name: '购物', amountCents: 8000, count: 1 }]);
    expect(summary.daily[0].expenseCents).toBe(8000);
    expect((await listTransactions(db, { kind: 'expense' })).items[0]).toMatchObject({ id: outgoing.id, amountCents: 10000, refundAdjustment: { netExpenseCents: 8000 } });
  });
  it('新手工转账必须声明方向，方向与类别冲突会拒绝且不写入半成品', async () => {
    await expect(create({ kind: 'transfer' })).rejects.toMatchObject({ status: 422 });
    expect(() => normalizeInput({ ...base, kind: 'expense', transferDirection: 'inflow' })).toThrow('只有转账可以设置资金方向');
    const original = (await create({ kind: 'transfer', transferDirection: 'outflow', categoryId: 'food' })).transaction;
    await expect(updateTransaction(db, original.id, normalizeInput({ ...base, kind: 'transfer', transferDirection: 'inflow', categoryId: 'food' }), 1)).rejects.toMatchObject({ status: 422 });
    const corrected = await updateTransaction(db, original.id, normalizeInput({ ...base, kind: 'transfer', transferDirection: 'inflow', categoryId: 'salary', categoryOverride: true }), 1);
    expect(corrected).toMatchObject({ kind: 'transfer', transferDirection: 'inflow', categoryId: 'salary', categorySource: 'manual', version: 2 });
    expect((await getSummary(db, '2026-11', now)).expenseCents).toBe(0);
    expect((await getSummary(db, '2026-11', now)).incomeCents).toBe(10000);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
  });
  it('转账按方向匹配收支规则，收入规则不能影响转出', async () => {
    await createCategoryRule(db, { keyword: '测试回款', kind: 'income', categoryId: 'other-income', matchType: 'contains', enabled: true });
    const incoming = (await create({ kind: 'transfer', transferDirection: 'inflow', description: '测试回款' })).transaction;
    const outgoing = (await create({ kind: 'transfer', transferDirection: 'outflow', description: '测试回款' })).transaction;
    expect(incoming).toMatchObject({ categoryId: 'other-income', categorySource: 'rule' });
    expect(outgoing).toMatchObject({ categoryId: null, categorySource: 'unclassified' });
    await createCategoryRule(db, { keyword: '测试回款', kind: 'expense', categoryId: 'shopping', matchType: 'contains', enabled: true });
    expect((await listTransactions(db, { kind: 'expense' })).items[0]).toMatchObject({ id: outgoing.id, categoryId: 'shopping', categorySource: 'rule' });
    expect(getTransactionCashflowKind(incoming)).toBe('income');
  });
  it('旧库方向迁移保留原交易与审计，未知方向不猜测，旧请求仍可重试', async () => {
    const old = new LocalDatabase(':memory:');
    try {
      for (const name of ['0001_platform.sql', '0002_ledger.sql', '0003_feishu_sync.sql', '0004_fixed_expenses.sql', '0005_category_rules.sql', '0006_custom_categories.sql']) {
        const sql = await readFile(resolve('migrations', name), 'utf8'); old.applyMigration(name, createHash('sha256').update(sql).digest('hex'), sql);
      }
      const normalized = normalizeInput({ ...base, kind: 'transfer', amount: '12.00' });
      const hash = await hashPayload({ ...normalized, source: 'manual', fingerprint: null, sourceDetails: null });
      const time = normalized.occurredAt;
      for (const [id, amount, details] of [['unknown', 1200, null], ['known', 18800, JSON.stringify({ transactionType: 'refund', direction: 'inflow', parserVersion: '1.1.4' })]] as const) {
        await old.prepare(`INSERT INTO transactions(id,occurred_at,kind,amount_cents,description,account_id,source,source_details,created_at,updated_at,idempotency_scope,idempotency_key,payload_hash)
          VALUES(?,?,'transfer',?,?,'cmb-default','manual',?,?,?,'manual',?,?)`).bind(id, time, amount, normalized.description, details, time, time, `${id}-legacy-key`, hash).run();
      }
      const before = (await old.prepare('SELECT * FROM transactions ORDER BY id').all()).results;
      const audit = (await old.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results;
      await applyMigrations(old, resolve('migrations'));
      const after = (await old.prepare('SELECT * FROM transactions ORDER BY id').all()).results;
      expect(after.map(({ fixed_auto_excluded: _fixedExclusion, transfer_direction: _, ...row }) => row)).toEqual(before);
      expect((await old.prepare('SELECT * FROM transaction_audit ORDER BY id').all()).results).toEqual(audit);
      expect(await old.prepare("SELECT transfer_direction FROM transactions WHERE id='known'").first('transfer_direction')).toBe('inflow');
      expect(await getSummary(old, '2026-11', now)).toMatchObject({ incomeCents: 18800, expenseCents: 0, unknownTransferCents: 1200, unknownTransferCount: 1 });
      const replay = await createTransaction(old, normalized, { key: 'unknown-legacy-key', scope: 'manual', source: 'manual' });
      expect(replay).toMatchObject({ duplicate: true, transaction: { id: 'unknown', transferDirection: null } });
      const selected = await updateTransaction(old, 'unknown', { ...normalized, transferDirection: 'outflow' }, 1);
      expect((await createTransaction(old, normalized, { key: 'unknown-legacy-key', scope: 'manual', source: 'manual' })).transaction).toEqual(selected);
    } finally { old.close(); }
  });
  it('新版备份保存显式方向，旧备份重入不覆盖用户选的方向', async () => {
    const parsed = parseCmb({ amount: '50.00', transaction_time: '2026-11-01T12:00:00+08:00', transaction_type: 'transfer_out', direction: 'outflow',
      description: '备份转账测试', transaction_fingerprint: 'backup-transfer-test', currency: 'CNY', bank: '招商银行', parser_version: '1.1.5' }, 'cmb-default');
    const options = { key: 'backup-transfer-key', scope: 'shortcut:cmb-default', source: 'shortcut' as const, fingerprint: parsed.fingerprint, sourceDetails: parsed.sourceDetails };
    const original = (await createTransaction(db, parsed.transaction, options)).transaction;
    await updateTransaction(db, original.id, { ...parsed.transaction, transferDirection: 'inflow' }, 1);
    const accessKey = `test-transfer_${'key'.repeat(20)}`, origin = 'https://transfer.test';
    const env: Env = { DB: db as D1Database, OWNER_ACCESS_KEY: accessKey, ASSETS: {} as Fetcher };
    const request = (path: string, body?: unknown, cookie = '') => app.request(`${origin}/api${path}`, { method: body ? 'POST' : 'GET',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    const login = await request('/session', { accessKey }); const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const backup = (await (await request('/backup', undefined, cookie)).json() as { data: CurrentBackup }).data;
    expect(backup.schemaVersion).toBe(7); expect(backup.transactions[0].transferDirection).toBe('inflow');
    const legacy = { ...backup, schemaVersion: 4, transactions: backup.transactions.map(({ transferDirection: _, ...transaction }) => transaction) };
    expect((await request('/backup/restore', legacy, cookie)).status).toBe(200);
    expect(await db.prepare('SELECT transfer_direction FROM transactions WHERE id=?').bind(original.id).first('transfer_direction')).toBe('inflow');
    const fresh = new LocalDatabase(':memory:');
    try {
      await applyMigrations(fresh, resolve('migrations')); env.DB = fresh as D1Database;
      const nextLogin = await request('/session', { accessKey }); const nextCookie = nextLogin.headers.get('Set-Cookie')!.split(';')[0];
      expect((await request('/backup/restore', backup, nextCookie)).status).toBe(200);
      const replay = await createTransaction(fresh, parsed.transaction, options);
      expect(replay).toMatchObject({ duplicate: true, transaction: { id: original.id, transferDirection: 'inflow' } });
      expect(replay.transaction.sourceDetails?.direction).toBe('outflow');
      const missing = { ...backup, transactions: backup.transactions.map(({ transferDirection: _, ...transaction }) => transaction) };
      expect((await request('/backup/restore', missing, nextCookie)).status).toBe(422);
    } finally { fresh.close(); }
  });
});
