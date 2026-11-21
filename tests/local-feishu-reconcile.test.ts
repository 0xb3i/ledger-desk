import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { createFeishuIntegration, parseFeishuRecord } from '../src/local/feishu';
import { getFeishuIssue, reconcileFeishuRecord, resolveFeishuIssue } from '../src/local/feishu-reconcile';
import { createTransaction, updateTransaction, getTransaction } from '../src/server/ledger/repository';
import { hashPayload, normalizeInput } from '../src/server/ledger/domain';
import { createApiApp } from '../src/server';
import type { Env } from '../src/server/types';
import type { FeishuIssueDetail } from '../src/shared/contracts';

let directory: string, db: LocalDatabase;
const config = { baseToken: 'baseFixture', tableId: 'tblFixture', accountId: 'cmb-default', cliPath: '/usr/local/bin/lark-cli',
  sourceUrl: 'https://team.larkoffice.com/base/baseFixture?view=old' };
const sourceId = `${config.baseToken}:${config.tableId}:${config.accountId}`;
const recordId = 'recSourceA';
const record = (extra: Record<string, unknown> = {}) => ({ record_id: recordId, 交易主体: '', 金额: 2.6, 余额: 100.01,
  交易时间原文: '2026-11-01T12:00:00+08:00', 交易类型: ['消费'], 资金方向: ['流出'], 交易摘要: '来源商户',
  银行: '招商银行', 币种: 'CNY', 交易指纹: 'immutable-fingerprint', 解析版本: '1.1.4', ...extra });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'qingji-reconcile-')); db = new LocalDatabase(join(directory, 'ledger.sqlite')); await applyMigrations(db, resolve('migrations')); });
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
async function setup(initial = record()) {
  let rows: Record<string, unknown>[] = [initial];
  const options = { db, dataDir: directory, config, readRecords: async () => rows };
  const integration = await createFeishuIntegration(options);
  await integration.sync();
  const id = (await db.prepare('SELECT transaction_id FROM local_feishu_records').first<{ transaction_id: string }>())!.transaction_id;
  return { integration, options, id, setRemote: (next: Record<string, unknown>) => { rows = [next]; } };
}
const checkpoint = () => db.prepare('SELECT * FROM local_feishu_records WHERE source_id=? AND record_id=?').bind(sourceId, recordId).first<Record<string, unknown>>();
const auditCount = () => db.prepare('SELECT COUNT(*) AS n FROM transaction_audit').first<number>('n');

describe('飞书来源三方合并与核对', () => {
  it('旧检查点由原始审计验证，补主体不覆盖用户改过的类型、分类和备注', async () => {
    const original = record({ 交易类型: ['其他入账'], 资金方向: ['流入'], 交易摘要: '财付通-测试用户-微信零钱提现' });
    const { integration, id, setRemote, options } = await setup(original);
    const first = await getTransaction(db, id);
    await updateTransaction(db, id, normalizeInput({ occurredAt: first.occurred_at, kind: 'income', amount: '2.60', description: first.description,
      counterparty: '', accountId: 'cmb-default', categoryId: 'other-income', note: '用户的收入说明' }), first.version);
    await db.prepare('UPDATE local_feishu_records SET source_snapshot=NULL').run();
    const before = await getTransaction(db, id);
    setRemote({ ...original, 交易主体: original.交易摘要, 解析版本: '1.1.5' });
    expect(await integration.sync()).toMatchObject({ issues: [], lastError: null });
    expect(await getTransaction(db, id)).toMatchObject({ kind: 'income', amount_cents: 260, counterparty: original.交易摘要,
      category_id: 'other-income', category_source: 'manual', note: '用户的收入说明', fingerprint: first.fingerprint,
      payload_hash: first.payload_hash, idempotency_key: first.idempotency_key, version: before.version + 1 });
    expect((await checkpoint())!.source_snapshot).not.toBeNull();
    const audit = await auditCount(), version = (await getTransaction(db, id)).version;
    const restarted = await createFeishuIntegration(options); await restarted.sync();
    expect(await auditCount()).toBe(audit); expect((await getTransaction(db, id)).version).toBe(version);
  });

  it('元数据采用逐字段三方合并，本地独立修改不会被覆盖', async () => {
    const { integration, id, setRemote } = await setup();
    await db.prepare("UPDATE transactions SET description='我自己的名称',counterparty='我自己的主体',note='手工备注',version=version+1").run();
    setRemote(record({ 交易主体: '新的来源主体', 交易摘要: '新的来源描述', 解析版本: '1.1.5' }));
    expect((await integration.sync()).issues).toEqual([]);
    const current = await getTransaction(db, id);
    expect(current).toMatchObject({ description: '我自己的名称', counterparty: '我自己的主体', note: '手工备注' });
    expect(JSON.parse(current.source_details!)).toMatchObject({ parserVersion: '1.1.5' });
  });

  it('未知旧基线不会假借已编辑的当前账单自动接受来源变化', async () => {
    const { integration, id, setRemote } = await setup();
    await db.prepare("UPDATE local_feishu_records SET source_snapshot=NULL,source_hash=?").bind('f'.repeat(64)).run();
    await db.prepare("UPDATE transactions SET counterparty='新的主体',version=version+1").run();
    setRemote(record({ 交易主体: '新的主体' }));
    expect((await integration.sync()).issues).toHaveLength(1);
    const detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.baselineAvailable).toBe(false);
    expect((await getTransaction(db, id)).amount_cents).toBe(260);
  });

  it('兼容识别零钱提现之前的原始credit表示，但必须匹配原哈希', async () => {
    const original = record({ 交易类型: ['其他入账'], 资金方向: ['流入'], 交易摘要: '财付通-测试用户-微信零钱提现' });
    const parsed = parseFeishuRecord(original, config.accountId).parsed;
    const legacy = { ...parsed, transaction: { ...parsed.transaction, kind: 'income' as const, note: '其他入账，请确认是否属于收入。' }, needsReview: true };
    const result = await createTransaction(db, legacy.transaction, { source: 'shortcut', scope: 'shortcut:cmb-default', key: 'lark:tblFixture:recSourceA',
      fingerprint: legacy.fingerprint, needsReview: legacy.needsReview, sourceDetails: legacy.sourceDetails });
    await db.prepare('INSERT INTO local_feishu_records(source_id,record_id,source_hash,transaction_id) VALUES(?,?,?,?)')
      .bind(sourceId, recordId, await hashPayload(legacy), result.transaction.id).run();
    const integration = await createFeishuIntegration({ db, dataDir: directory, config, readRecords: async () => [{ ...original, 交易主体: original.交易摘要 }] });
    expect((await integration.sync()).issues).toEqual([]);
    expect(await getTransaction(db, result.transaction.id)).toMatchObject({ kind: 'income', review_status: 'pending', counterparty: original.交易摘要 });
  });

  it('真实金额差异持久化，保留本地完成核对后重启不再重复提示', async () => {
    const { integration, options, id, setRemote } = await setup();
    setRemote(record({ 金额: 3.5 }));
    const changed = await integration.sync();
    expect(changed.issues[0]).toMatchObject({ kind: 'changed', transactionId: id, description: '来源商户' });
    const detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.changes).toEqual([{ field: 'amount', label: '金额', localValue: '¥2.60', remoteValue: '¥3.50' }]);
    expect(detail.baselineAvailable).toBe(true);
    await resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'keep-local');
    const restarted = await createFeishuIntegration(options);
    expect(restarted.status().issues).toEqual([]);
    expect((await restarted.sync()).issues).toEqual([]);
    expect((await getTransaction(db, id)).amount_cents).toBe(260);
    setRemote(record({ 金额: 4.5 }));
    expect((await restarted.sync()).issues).toHaveLength(1);
  });

  it('采用飞书仅更新来源变化字段，保留本地独立编辑与原请求回执', async () => {
    const { integration, id, setRemote } = await setup();
    await db.prepare("UPDATE transactions SET description='自定义名称',note='自定义备注',category_id='food',category_source='manual',version=version+1").run();
    const before = await getTransaction(db, id), beforeAudits = await auditCount();
    setRemote(record({ 金额: 3.5, 余额: 99.11 })); await integration.sync();
    const detail = await getFeishuIssue(db, sourceId, recordId);
    await resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'use-remote');
    const after = await getTransaction(db, id);
    expect(after).toMatchObject({ amount_cents: 350, description: '自定义名称', note: '自定义备注', category_id: 'food',
      category_source: 'manual', fingerprint: before.fingerprint, payload_hash: before.payload_hash, idempotency_key: before.idempotency_key, version: before.version + 1 });
    expect(JSON.parse(after.source_details!)).toMatchObject({ balance: '99.11' });
    expect(await auditCount()).toBe(beforeAudits! + 1);
    expect((await checkpoint())!.pending_snapshot).toBeNull();
  });

  it('差异列展示实际将改变的本地账单类型，不能只显示原始来源类型', async () => {
    const { integration, id, setRemote } = await setup();
    await db.prepare("UPDATE transactions SET kind='income',category_id='other',category_source='manual',version=version+1").run();
    setRemote(record({ 交易类型: ['转出'] })); await integration.sync();
    const detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.changes).toContainEqual({ field: 'ledgerKind', label: '账单类型', localValue: '收入', remoteValue: '转出' });
    await resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'use-remote');
    expect(await getTransaction(db, id)).toMatchObject({ kind: 'transfer', transfer_direction: 'outflow', category_id: 'other', category_source: 'manual' });
  });

  it('类型冲突不能清空手工类目或固定标记来强行采用', async () => {
    const { integration, id, setRemote } = await setup();
    await db.prepare("UPDATE transactions SET category_id='food',category_source='manual',version=version+1").run();
    setRemote(record({ 交易类型: ['工资'], 资金方向: ['流入'] })); await integration.sync();
    let detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.canApplyRemote).toBe(false);
    await expect(resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'use-remote')).rejects.toMatchObject({ status: 422 });
    expect((await getTransaction(db, id)).category_id).toBe('food');
    await db.prepare("UPDATE transactions SET category_id='other',is_fixed=1,version=version+1").run();
    detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.applyRemoteBlockedReason).toContain('固定支出');
    await resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'keep-local');
    expect((await getTransaction(db, id)).is_fixed).toBe(1);
  });

  it('指纹变化必须核对且不能覆盖原指纹，保留本地可以完成处理', async () => {
    const { integration, id, setRemote } = await setup();
    setRemote(record({ 交易指纹: 'different-fingerprint' })); await integration.sync();
    const detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.canApplyRemote).toBe(false);
    await resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'keep-local');
    expect((await getTransaction(db, id)).fingerprint).toBe('immutable-fingerprint');
  });

  it('来源恢复原值自动撤销待处理变化，已删除账单也不会复活', async () => {
    const { integration, id, setRemote } = await setup();
    setRemote(record({ 金额: 3.5 })); await integration.sync();
    setRemote(record()); expect((await integration.sync()).issues).toEqual([]);
    await db.prepare("UPDATE transactions SET deleted_at='2026-11-02T00:00:00Z',version=version+1").run();
    const before = await getTransaction(db, id), audits = await auditCount();
    setRemote(record({ 金额: 4.5, 交易主体: '已删除记录的新主体' }));
    expect((await integration.sync()).issues).toEqual([]);
    expect(await getTransaction(db, id)).toEqual(before); expect(await auditCount()).toBe(audits);
  });

  it('真实冲突后网络失败仍保留入口，状态缓存丢失也从pending恢复', async () => {
    let rows = [record()], fail = false;
    const options = { db, dataDir: directory, config, readRecords: async () => { if (fail) throw new Error('网络断开'); return rows; } };
    const integration = await createFeishuIntegration(options); await integration.sync();
    rows = [record({ 金额: 3.5 })]; await integration.sync();
    fail = true;
    expect(await integration.sync()).toMatchObject({ lastError: '网络断开', issues: [expect.objectContaining({ kind: 'changed', recordId })] });
    await db.prepare('DELETE FROM local_integration_state').run();
    const restarted = await createFeishuIntegration(options);
    expect(restarted.status().issues).toHaveLength(1);
    const detail = await getFeishuIssue(db, sourceId, recordId);
    expect(detail.changes[0].remoteValue).toBe('¥3.50');
  });

  it('陈旧详情不能覆盖更新的本地账单或更新后的远端变化', async () => {
    const { integration, id, setRemote } = await setup();
    setRemote(record({ 金额: 3.5 })); await integration.sync();
    const first = await getFeishuIssue(db, sourceId, recordId);
    await db.prepare("UPDATE transactions SET note='并发编辑',version=version+1").run();
    await expect(resolveFeishuIssue(db, sourceId, recordId, first.snapshot, 'use-remote')).rejects.toMatchObject({ status: 409 });
    const second = await getFeishuIssue(db, sourceId, recordId);
    setRemote(record({ 金额: 4.5 })); await integration.sync();
    await expect(resolveFeishuIssue(db, sourceId, recordId, second.snapshot, 'use-remote')).rejects.toMatchObject({ status: 409 });
    expect(await getTransaction(db, id)).toMatchObject({ note: '并发编辑', amount_cents: 260 });
  });

  it('合并提交中途有并发或后续失败，检查点、账单和审计原子回滚', async () => {
    const { id } = await setup();
    const beforeCheckpoint = await checkpoint();
    let calls = 0;
    const concurrent = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
      if (++calls === 2) await db.prepare("UPDATE transactions SET counterparty='用户刚修改',version=version+1").run();
      return db.batch(statements);
    } } as unknown as D1Database;
    const parsed = parseFeishuRecord(record({ 交易主体: '来源补充' }), config.accountId).parsed;
    await expect(reconcileFeishuRecord(concurrent, sourceId, recordId, parsed, await hashPayload(parsed))).rejects.toMatchObject({ status: 409 });
    expect(await checkpoint()).toEqual(beforeCheckpoint);
    expect((await getTransaction(db, id)).counterparty).toBe('用户刚修改');
    const financial = parseFeishuRecord(record({ 金额: 3.5 }), config.accountId).parsed;
    await reconcileFeishuRecord(db, sourceId, recordId, financial, await hashPayload(financial));
    const detail = await getFeishuIssue(db, sourceId, recordId), current = await getTransaction(db, id), cp = await checkpoint(), audits = await auditCount();
    await expect(resolveFeishuIssue(db, sourceId, recordId, detail.snapshot, 'use-remote', [db.prepare("INSERT INTO restore_guards(id,valid) VALUES('fail',0)")])).rejects.toMatchObject({ status: 409 });
    expect(await getTransaction(db, id)).toEqual(current); expect(await checkpoint()).toEqual(cp); expect(await auditCount()).toBe(audits);
    expect(await db.prepare('SELECT COUNT(*) FROM restore_guards').first('COUNT(*)')).toBe(0);
  });

  it('核对API要求会话与同源，成功后同步状态和检查点一起更新', async () => {
    const { integration, setRemote, options } = await setup();
    setRemote(record({ 金额: 3.5 })); await integration.sync();
    const app = createApiApp(integration.routes), origin = 'https://reconciliation.test';
    const accessKey = 'pd_owner_' + 'reconciliation-test'.repeat(4), env = { DB: db, OWNER_ACCESS_KEY: accessKey } as unknown as Env;
    const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(origin + '/api' + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    }, env);
    const path = '/integrations/feishu/issues/' + recordId;
    expect((await request(path)).status).toBe(401);
    const logged = await request('/session', 'POST', { accessKey }, { Origin: origin });
    const cookie = logged.headers.get('Set-Cookie')!.split(';')[0];
    const detail = (await (await request(path, 'GET', undefined, { Cookie: cookie })).json() as { data: FeishuIssueDetail }).data;
    expect(detail.recordUrl).toBe('https://team.larkoffice.com/base/baseFixture?table=tblFixture&record=recSourceA');
    const payload = { snapshot: detail.snapshot, action: 'keep-local' };
    expect((await request(path + '/resolve', 'POST', payload, { Cookie: cookie })).status).toBe(403);
    const response = await request(path + '/resolve', 'POST', payload, { Cookie: cookie, Origin: origin });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { issues: [], lastError: null } });
    expect((await createFeishuIntegration(options)).status().issues).toEqual([]);
    expect((await request(path, 'GET', undefined, { Cookie: cookie })).status).toBe(404);
    setRemote(record({ 金额: 4.5 })); await integration.sync();
    const oldPending = await getFeishuIssue(db, sourceId, recordId);
    setRemote(record({ 金额: '无效金额' }));
    expect((await integration.sync()).issues[0]).toMatchObject({ kind: 'invalid', recordId });
    expect((await request(path, 'GET', undefined, { Cookie: cookie })).status).toBe(422);
    expect((await request(path + '/resolve', 'POST', { snapshot: oldPending.snapshot, action: 'use-remote' }, { Cookie: cookie, Origin: origin })).status).toBe(422);
    expect((await createFeishuIntegration(options)).status().issues[0].kind).toBe('invalid');
  });
});
