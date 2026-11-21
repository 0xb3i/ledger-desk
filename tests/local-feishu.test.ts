import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { createFeishuIntegration, decimalText, parseFeishuRecord } from '../src/local/feishu';
import { hashPayload } from '../src/server/ledger/domain';
import { createTransaction } from '../src/server/ledger/repository';
import { getSummary } from '../src/server/ledger/queries';

let directory: string, db: LocalDatabase;
const config = { baseToken: 'baseFixture', tableId: 'tblFixture', accountId: 'cmb-default', cliPath: '/usr/local/bin/lark-cli' };
const record = () => ({ record_id: 'recFixtureA', 交易主体: '隔离测试商户', 金额: 2.6, 余额: 100.01,
  交易时间原文: '2026-11-01T12:00:00+08:00', 交易类型: ['消费'], 资金方向: ['流出'],
  交易摘要: '带"引号"\n与换行的隔离测试', 银行: '招商银行', 币种: 'CNY', 交易指纹: 'fixture-fingerprint', 解析版本: '1.1.4' });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'qingji-sync-test-')); db = new LocalDatabase(join(directory, 'test.sqlite')); await applyMigrations(db, resolve('migrations')); });
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
const count = () => db.prepare('SELECT COUNT(*) FROM transactions').first<number>('COUNT(*)');

describe('本地飞书同步', () => {
  it.each([
    [undefined, 'https://www.feishu.cn/base/baseFixture?table=tblFixture'],
    ['https://team.larkoffice.com/base/baseFixture?table=tblOld&view=vewOld&record=recOld#old', 'https://team.larkoffice.com/base/baseFixture?table=tblFixture'],
  ])('来源入口指向当前同步表，不携带旧记录或页面参数：%s', async (sourceUrl, expected) => {
    const integration = await createFeishuIntegration({ db, dataDir: directory, config: { ...config, sourceUrl } });
    expect(integration.status().sourceUrl).toBe(expected);
  });

  it('旧快捷指令的真实字段协议转为整数分，保留摘要与余额', () => {
    const parsed = parseFeishuRecord(record(), 'cmb-default').parsed;
    expect(parsed.transaction.amountCents).toBe(260);
    expect(parsed.transaction.description).toBe(record().交易摘要);
    expect(parsed.sourceDetails.balance).toBe('100.01');
    expect(decimalText(-0.01)).toBe('-0.01');
    expect(() => decimalText(1.001)).toThrow();
    expect(() => parseFeishuRecord({ ...record(), 交易类型: ['消费', '退款'] }, 'cmb-default')).toThrow();
  });
  it('按飞书记录ID重复同步不会重复入账，重启也保留同步状态', async () => {
    const options = { db, dataDir: directory, config, readRecords: async () => [record()] };
    const integration = await createFeishuIntegration(options);
    expect((await integration.sync()).recordCount).toBe(1);
    expect((await integration.sync()).lastError).toBeNull();
    expect(await count()).toBe(1);
    const restarted = await createFeishuIntegration(options);
    expect(restarted.status().recordCount).toBe(1);
    expect(restarted.status().lastSuccessAt).not.toBeNull();
    expect(restarted.status().syncing).toBe(false);
    await restarted.sync(); expect(await count()).toBe(1);
  });
  it.each([null, undefined])('交易主体缺失不丢弃已有摘要，其他必填字段仍须有效：%s', (counterparty) => {
    const row = { ...record(), 交易主体: counterparty };
    expect(parseFeishuRecord(row, 'cmb-default').parsed.transaction).toMatchObject({ counterparty: '', description: record().交易摘要 });
    expect(() => parseFeishuRecord({ ...row, 交易摘要: null }, 'cmb-default')).toThrow();
    expect(() => parseFeishuRecord({ ...row, 交易主体: ['甲', '乙'] }, 'cmb-default')).toThrow();
  });
  it('主体为空的零钱提现首次同步完整入账，重复同步和重启均不新增或覆盖本地修改', async () => {
    const row = { ...record(), 交易主体: null, 交易类型: ['其他入账'], 资金方向: ['流入'], 交易摘要: '财付通-测试姓名-微信零钱提现' };
    const options = { db, dataDir: directory, config, readRecords: async () => [row] };
    const integration = await createFeishuIntegration(options);
    expect(await integration.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    expect(await db.prepare('SELECT kind,description,counterparty,review_status,note FROM transactions').first()).toEqual({
      kind: 'transfer', description: row.交易摘要, counterparty: '', review_status: 'confirmed', note: '',
    });
    await db.prepare("UPDATE transactions SET note='用户备注',version=version+1").run();
    await integration.sync();
    const restarted = await createFeishuIntegration(options);
    expect(await restarted.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    expect(await count()).toBe(1);
    expect(await db.prepare('SELECT note FROM transactions').first('note')).toBe('用户备注');
  });
  it('明确的零钱提现仍需核对同指纹的另一条记录', async () => {
    const row = { ...record(), 交易主体: null, 交易类型: ['其他入账'], 资金方向: ['流入'], 交易摘要: '财付通-测试姓名-微信零钱提现' };
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [row, { ...row, record_id: 'recFixtureB' }] });
    expect((await integration.sync()).recordCount).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) FROM transactions WHERE kind='transfer' AND review_status='pending'").first('COUNT(*)')).toBe(1);
  });
  it('明确的微信转账即使被旧解析器标为退款也计为转账，保留来源和回执并支持重复同步', async () => {
    const row = { ...record(), 金额: 188, 交易类型: ['退款'], 资金方向: ['流入'],
      交易主体: '财付通-微信支付-微信转账', 交易摘要: '财付通-微信支付-微信转账' };
    const parsed = parseFeishuRecord(row, 'cmb-default').parsed;
    expect(parsed.transaction.kind).toBe('refund');
    const expectedHash = await hashPayload({ ...parsed.transaction, source: 'shortcut', fingerprint: parsed.fingerprint, sourceDetails: parsed.sourceDetails });
    const options = { db, dataDir: directory, config, readRecords: async () => [row] };
    const integration = await createFeishuIntegration(options);
    expect(await integration.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    const stored = await db.prepare('SELECT id,kind,amount_cents,source_details,payload_hash,category_id,category_source FROM transactions').first<{
      id: string; kind: string; amount_cents: number; source_details: string; payload_hash: string; category_id: string | null; category_source: string;
    }>();
    expect(stored).toMatchObject({ kind: 'transfer', amount_cents: 18800, payload_hash: expectedHash, category_id: null, category_source: 'unclassified' });
    expect(JSON.parse(stored!.source_details)).toMatchObject({ transactionType: 'refund', direction: 'inflow', parserVersion: '1.1.4' });
    expect(await getSummary(db, '2026-11')).toMatchObject({ refundCents: 0, transferCents: 18800, transferInCents: 18800, incomeCents: 18800, expenseCents: 0 });
    const replay = await createTransaction(db, parsed.transaction, { source: 'shortcut', scope: `shortcut:${config.accountId}`,
      key: `lark:${config.tableId}:${row.record_id}`, fingerprint: parsed.fingerprint, needsReview: parsed.needsReview, sourceDetails: parsed.sourceDetails });
    expect(replay.duplicate).toBe(true);
    expect(replay.transaction).toMatchObject({ id: stored!.id, kind: 'transfer' });
    const checkpoints = (await db.prepare('SELECT * FROM local_feishu_records').all()).results;
    await integration.sync();
    const restarted = await createFeishuIntegration(options);
    expect(await restarted.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    expect(await count()).toBe(1);
    expect((await db.prepare('SELECT * FROM local_feishu_records').all()).results).toEqual(checkpoints);
    expect(await db.prepare('SELECT COUNT(*) FROM transaction_audit').first('COUNT(*)')).toBe(1);
  });
  it.each(['微信转账', ' 财付通 － 微信支付 － 微信转账。 '])('微信转账消费流出按转账统计，明确摘要可归一化：%s', async (description) => {
    const row = { ...record(), 交易摘要: description, 金额: 188 };
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [row] });
    expect(await integration.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    expect(await db.prepare('SELECT kind FROM transactions').first('kind')).toBe('transfer');
    expect(await getSummary(db, '2026-11')).toMatchObject({ expenseCents: 18800, transferOutCents: 18800, transferCents: 18800 });
  });
  it.each(['其他入账', '转账转入', 'transfer_in'])('微信转账入账兼容旧与新版来源类型：%s', async (transactionType) => {
    const row = { ...record(), 交易摘要: '财付通-微信支付-微信转账', 金额: 188, 交易类型: [transactionType], 资金方向: ['流入'] };
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [row] });
    expect(await integration.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    expect(await db.prepare('SELECT kind,note,review_status FROM transactions').first()).toEqual({ kind: 'transfer', note: '', review_status: 'confirmed' });
  });
  it.each(['美团-商户退款', '微信转账退款', '财付通-微信支付-微信转账失败退款',
    '财付通-微信支付-微信转账手续费退还', '朋友还款备注：微信转账'])('有退款或其他含义的摘要保留退款类型，不凭转账字样改写：%s', async (description) => {
    const row = { ...record(), 交易摘要: description, 金额: 188, 交易类型: ['退款'], 资金方向: ['流入'] };
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [row] });
    expect(await integration.sync()).toMatchObject({ recordCount: 1, lastError: null, issues: [] });
    expect(await db.prepare('SELECT kind FROM transactions').first('kind')).toBe('refund');
    expect(await getSummary(db, '2026-11')).toMatchObject({ refundCents: 18800, transferCents: 0 });
  });
  it('飞书原记录改变时不覆盖本地编辑，也不新增副本', async () => {
    let rows = [record()];
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => rows });
    await integration.sync();
    await db.prepare("UPDATE transactions SET note='用户自己的备注',version=version+1").run();
    rows = [{ ...record(), 金额: 3.5 }];
    const status = await integration.sync();
    expect(status.issues).toHaveLength(1); expect(await count()).toBe(1);
    expect(await db.prepare('SELECT amount_cents,note FROM transactions').first()).toEqual({ amount_cents: 260, note: '用户自己的备注' });
  });
  it('本地撤销的账目不因下次同步复活', async () => {
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [record()] });
    await integration.sync();
    await db.prepare("UPDATE transactions SET deleted_at='2026-11-02T00:00:00Z',version=version+1").run();
    await integration.sync();
    expect(await count()).toBe(1);
    expect(await db.prepare('SELECT deleted_at FROM transactions').first('deleted_at')).toBe('2026-11-02T00:00:00Z');
  });
  it('相同指纹的两条记录不静默丢弃，第二条进入待核对', async () => {
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [record(), { ...record(), record_id: 'recFixtureB' }] });
    const status = await integration.sync(); expect(status.recordCount).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) FROM transactions WHERE review_status='pending'").first('COUNT(*)')).toBe(1);
  });
  it('坏记录可见报错且不阻止其他正确记录导入', async () => {
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [{ ...record(), record_id: 'recBad', 金额: 0 }, record()] });
    const status = await integration.sync(); expect(status.recordCount).toBe(1);
    expect(status.lastError).toBe('1 条飞书账单需要核对。'); expect(status.issues[0].recordId).toBe('recBad');
  });
  it('网络失败保留已导入账目与上次成功时间', async () => {
    let fail = false;
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => { if (fail) throw new Error('网络不可用'); return [record()]; } });
    const first = await integration.sync(); fail = true;
    const second = await integration.sync(); expect(second.lastSuccessAt).toBe(first.lastSuccessAt);
    expect(second.lastError).toBe('网络不可用'); expect(await count()).toBe(1); expect(second.syncing).toBe(false);
  });
  it('定时和手动同步并发时只读取一次飞书', async () => {
    let calls = 0;
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => { calls++; return [record()]; } });
    const first = integration.sync(), second = integration.sync();
    expect(first).toBe(second); await Promise.all([first, second]); expect(calls).toBe(1); expect(await count()).toBe(1);
  });
  it('未配置时不发起读取、不伪造成功', async () => {
    const integration = await createFeishuIntegration({ db, dataDir: directory });
    expect((await integration.sync()).configured).toBe(false); expect(integration.status().sourceUrl).toBeUndefined(); expect(integration.status().lastSuccessAt).toBeNull(); expect(await count()).toBe(0);
  });
});
