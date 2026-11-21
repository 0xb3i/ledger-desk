import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { createMailIntegration, type MailTransport } from '../src/local/mail';
import type { MailSecretStore } from '../src/local/keychain';
import type { FetchedMessage, ImapPullQuery, MailboxStatus } from '../src/local/imap';
import { createFeishuIntegration } from '../src/local/feishu';
import { parseCmbEmailBody } from '../src/server/ledger/cmb-email-parser';

let directory: string;
let db: LocalDatabase;

function createMemorySecretStore(): MailSecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(account) { return map.get(account.toLowerCase()) ?? null; },
    async set(account, secret) { map.set(account.toLowerCase(), secret); },
    async delete(account) { map.delete(account.toLowerCase()); },
  };
}

function makeMessage(uid: number, text: string, opts?: { subject?: string; date?: string; messageId?: string; from?: string }): FetchedMessage {
  const date = new Date(opts?.date ?? '2026-11-20T10:00:00+08:00');
  return {
    uid,
    internalDate: date,
    email: {
      from: opts?.from ?? '招商银行 <95555@cmbchina.com>',
      subject: opts?.subject ?? '账户变动通知',
      date,
      messageId: opts?.messageId ?? `<msg-${uid}@cmbchina.com>`,
      contentType: 'text/plain; charset=utf-8',
      contentTransferEncoding: '7bit',
      text,
    },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qingji-mail-test-'));
  db = new LocalDatabase(join(directory, 'test.sqlite'));
  await applyMigrations(db, resolve('migrations'));
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe('QQ 邮箱本地只读同步', () => {
  it('配置后授权码存入钥匙串而非 mail.json，增量同步不重复入账，重启保持游标', async () => {
    const secrets = createMemorySecretStore();
    const queries: ImapPullQuery[] = [];
    let messages: FetchedMessage[] = [
      makeMessage(10, '您账户1234于11月20日09:30在财付通-星巴克快捷支付38.00元，余额1000.00。'),
      makeMessage(11, '招商银行理财推广邮件，非交易提醒。'),
    ];
    const transport: MailTransport = {
      async testConnection(): Promise<MailboxStatus> { return { uidValidity: 7, uidNext: 12 }; },
      async pullMessages(_opts, query) {
        queries.push(query);
        const filtered = messages.filter(m => query.fromUid === undefined || m.uid > query.fromUid);
        return {
          mailbox: { uidValidity: 7, uidNext: Math.max(...messages.map(m => m.uid)) + 1 },
          scannedMaxUid: filtered.length ? Math.max(...filtered.map(m => m.uid)) : null,
          messages: filtered,
        };
      },
    };

    const integration = await createMailIntegration({ db, dataDir: directory, secretStore: secrets, transport });

    // Test via integration API routes wrapped with DB env
    const postConfig = await integration.routes.request('/mail/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'TestUser@QQ.com', authCode: 'abcdefghijklmnop', syncStartDate: '2026-11-19' }),
    }, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(postConfig.status).toBe(200);
    const configured = (await postConfig.json() as { data: { configured: boolean; email: string; recordCount: number; lastError: string | null } }).data;
    expect(configured).toMatchObject({ configured: true, email: 'testuser@qq.com', recordCount: 1, lastError: null });

    // Auth code must live ONLY in Keychain, never in mail.json
    expect(secrets.map.get('testuser@qq.com')).toBe('abcdefghijklmnop');
    const savedFile = await readFile(join(directory, 'mail.json'), 'utf8');
    expect(savedFile).not.toContain('abcdefghijklmnop');
    expect((await stat(join(directory, 'mail.json'))).mode & 0o777).toBe(0o600);

    // Second sync uses incremental fromUid=11 and imports only brand-new message 12
    messages = [
      ...messages,
      makeMessage(12, '您账户1234于11月20日12:00在支付宝-午餐快捷支付25.00元，余额975.00。'),
    ];
    const second = await integration.sync();
    expect(second.recordCount).toBe(2);
    expect(queries[1].fromUid).toBe(11);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(2);

    // Restart loads mail.json and keeps cursor without re-importing
    const restarted = await createMailIntegration({ db, dataDir: directory, secretStore: secrets, transport });
    const third = await restarted.sync();
    expect(third.recordCount).toBe(2);
    expect(queries[2].fromUid).toBe(12);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(2);
  });

  it.each([7, 99])('范围补扫后增量仍沿原游标读取（补扫 UIDVALIDITY=%i）', async rangeValidity => {
    const secrets = createMemorySecretStore();
    await secrets.set('123456@qq.com', 'abcdefghijklmnop');
    const queries: ImapPullQuery[] = [];
    const transport: MailTransport = {
      async testConnection() { return { uidValidity: 7, uidNext: 11 }; },
      async pullMessages(_opts, query) {
        queries.push(query);
        if (query.beforeDate) return { mailbox: { uidValidity: rangeValidity, uidNext: 101 }, scannedMaxUid: 100, messages: [] };
        return { mailbox: { uidValidity: 7, uidNext: 11 }, scannedMaxUid: 10, messages: [] };
      },
    };
    const integration = await createMailIntegration({ db, dataDir: directory, secretStore: secrets, transport,
      config: { provider: 'qq', email: '123456@qq.com', host: 'imap.qq.com', port: 993, mailbox: 'INBOX', accountId: 'cmb-default', syncStartDate: '2026-11-01' } });
    await integration.sync();
    await integration.sync({ startDate: '2026-11-19', endDate: '2026-11-20' });
    await integration.sync();
    expect(queries[1]).toMatchObject({ sinceDate: '2026-11-19', beforeDate: '2026-11-21' });
    expect(queries[2]).toMatchObject({ expectedUidValidity: 7, fromUid: 10 });
    await integration.stop();
  });

  it('配置测试期间拒绝并发同步，单封超大邮件可打开待核对且不重拉正文', async () => {
    const secrets = createMemorySecretStore();
    let connectionStarted!: () => void, allowConnection!: () => void;
    const started = new Promise<void>(resolve => { connectionStarted = resolve; });
    const canConnect = new Promise<void>(resolve => { allowConnection = resolve; });
    let singleMessageFetches = 0;
    const mailbox = { uidValidity: 7, uidNext: 3 };
    const transport: MailTransport = {
      async testConnection() { connectionStarted(); await canConnect; return mailbox; },
      async pullMessages() {
        return { mailbox, scannedMaxUid: 2, messages: [
          { ...makeMessage(1, ''), decodeError: '邮件超过 25 MB' },
          makeMessage(2, '您账户1234于11月20日12:00在支付宝-午餐快捷支付25.00元，余额975.00。'),
        ] };
      },
      async fetchMessage() { singleMessageFetches++; return null; },
    };
    const integration = await createMailIntegration({ db, dataDir: directory, secretStore: secrets, transport });
    const env = { DB: db, OWNER_ACCESS_KEY: 'test' };
    const update = integration.routes.request('/mail/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@qq.com', authCode: 'abcdefghijklmnop', syncStartDate: '2026-11-01' }),
    }, env);
    await started;
    try { expect(() => integration.sync()).toThrow('正在更新'); }
    finally { allowConnection(); }
    expect((await update).status).toBe(200);
    const status = await integration.status();
    expect(status.recordCount).toBe(1);
    expect(status.issues).toMatchObject([{ uid: 1, message: '邮件超过 25 MB' }]);
    const detail = await integration.routes.request('/mail/issues/7/1', {}, env);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ data: { message: '邮件超过 25 MB' } });
    expect(singleMessageFetches).toBe(0);
    await integration.stop();
  });

  it('从飞书平滑切换时按交易指纹自动跳过历史已导入账单，并支持日期补扫与忽略异常邮件', async () => {
    const secrets = createMemorySecretStore();
    await secrets.set('user@qq.com', 'abcdefghijklmnop');

    // 1. Seed a historical transaction previously imported from Feishu
    const overlapBody = '您账户1234于11月19日18:30在财付通-海底捞快捷支付218.00元，余额800.00。';
    const expected = await parseCmbEmailBody(overlapBody, 'cmb-default', new Date('2026-11-19T18:31:00+08:00'));
    expect(expected.status).toBe('parsed');
    if (expected.status !== 'parsed') return;

    const feishu = await createFeishuIntegration({
      db,
      dataDir: directory,
      config: { baseToken: 'baseOld', tableId: 'tblOld', accountId: 'cmb-default', cliPath: '/usr/local/bin/lark-cli' },
      readRecords: async () => [{
        record_id: 'recLegacy01',
        交易主体: '财付通-海底捞',
        金额: 218,
        余额: 800,
        交易时间原文: '2026-11-19T18:30:00+08:00',
        交易类型: ['消费'],
        资金方向: ['流出'],
        交易摘要: '财付通-海底捞',
        银行: '招商银行',
        币种: 'CNY',
        交易指纹: expected.payload.transaction_fingerprint,
        解析版本: '1.1.5',
      }],
    });
    await feishu.sync();
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);

    // 2. QQ Mail pulls overlapping email (uid 20) + brand-new email (uid 21) + unparseable CMB email (uid 22)
    const transport: MailTransport = {
      async testConnection() { return { uidValidity: 9, uidNext: 23 }; },
      async pullMessages() {
        return {
          mailbox: { uidValidity: 9, uidNext: 23 },
          scannedMaxUid: 22,
          messages: [
            makeMessage(20, overlapBody, { date: '2026-11-19T18:31:00+08:00' }),
            makeMessage(21, '您账户1234于11月20日08:00在支付宝-早餐快捷支付12.50元，余额787.50。', { date: '2026-11-20T08:01:00+08:00' }),
            makeMessage(22, '您账户1234于11月20日08:10发生新格式交易。', { subject: '新格式动账通知', date: '2026-11-20T08:11:00+08:00' }),
          ],
        };
      },
    };

    const mail = await createMailIntegration({
      db,
      dataDir: directory,
      config: { provider: 'qq', email: 'user@qq.com', host: 'imap.qq.com', port: 993, mailbox: 'INBOX', accountId: 'cmb-default', syncStartDate: '2026-11-18' },
      secretStore: secrets,
      transport,
    });

    const synced = await mail.sync();
    // Overlap transaction skipped, only uid 21 created, total transactions = 2 (1 Feishu + 1 Mail), 0 false pending duplicates!
    expect(synced.recordCount).toBe(1);
    expect(synced.skippedExistingCount).toBe(1);
    expect(synced.issues).toHaveLength(1);
    expect(synced.issues[0]).toMatchObject({ uidValidity: 9, uid: 22, subject: '新格式动账通知' });
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) FROM transactions WHERE review_status='pending'").first('COUNT(*)')).toBe(0);

    // 3. Dismiss the unparseable mail warning
    const dismissRes = await mail.routes.request('/mail/issues/9/22/dismiss', { method: 'POST', body: '{}' }, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(dismissRes.status).toBe(200);
    const afterDismiss = (await dismissRes.json() as { data: { issues: unknown[]; lastError: string | null } }).data;
    expect(afterDismiss.issues).toHaveLength(0);
    expect(afterDismiss.lastError).toBeNull();

    // 4. Date-range backfill with rotated UIDVALIDITY still deduplicates by Message-ID
    const rotatedTransport: MailTransport = {
      async testConnection() { return { uidValidity: 99, uidNext: 5 }; },
      async pullMessages() {
        return {
          mailbox: { uidValidity: 99, uidNext: 5 },
          scannedMaxUid: 2,
          messages: [
            makeMessage(1, '您账户1234于11月20日08:00在支付宝-早餐快捷支付12.50元，余额787.50。', { messageId: '<msg-21@cmbchina.com>' }),
          ],
        };
      },
    };
    const mailRotated = await createMailIntegration({
      db,
      dataDir: directory,
      config: { provider: 'qq', email: 'user@qq.com', host: 'imap.qq.com', port: 993, mailbox: 'INBOX', accountId: 'cmb-default', syncStartDate: '2026-11-18' },
      secretStore: secrets,
      transport: rotatedTransport,
    });
    const backfilled = await mailRotated.sync({ startDate: '2026-11-18', endDate: '2026-11-20' });
    expect(backfilled.recordCount).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(2);
  });

  it('断开邮箱会删除配置与钥匙串授权码，同时完整保留本地账目', async () => {
    const secrets = createMemorySecretStore();
    const transport: MailTransport = {
      async testConnection() { return { uidValidity: 1, uidNext: 2 }; },
      async pullMessages() {
        return {
          mailbox: { uidValidity: 1, uidNext: 2 },
          scannedMaxUid: 1,
          messages: [makeMessage(1, '您账户1234于11月20日09:00在便利店快捷支付9.90元，余额500.00。')],
        };
      },
    };
    const mail = await createMailIntegration({ db, dataDir: directory, secretStore: secrets, transport });
    await mail.routes.request('/mail/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@qq.com', authCode: 'abcdefghijklmnop', syncStartDate: '2026-11-19' }),
    }, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);

    const del = await mail.routes.request('/mail/config', { method: 'DELETE' }, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(del.status).toBe(200);
    const status = (await del.json() as { data: { configured: boolean } }).data;
    expect(status.configured).toBe(false);
    expect(secrets.map.has('user@qq.com')).toBe(false);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(1);
  });

  it('在本地检查邮件头后按批流式入账，不依赖服务端 FROM 搜索', async () => {
    const secrets = createMemorySecretStore();
    await secrets.set('user@qq.com', 'abcdefghijklmnop');
    let countDuringSync = 0;
    let progressDuringSync: { total: number; processed: number; imported: number } | null | undefined;
    let seenFromFilter: string | undefined;
    let seenFromUid: number | undefined;
    let seenSinceDate: string | undefined;
    let incrementalFromUid: number | undefined;
    let pullCount = 0;

    const transport: MailTransport = {
      async testConnection() { return { uidValidity: 5, uidNext: 30 }; },
      async pullMessages(_opts, query) {
        seenFromFilter = query.fromContains;
        seenFromUid = query.fromUid;
        seenSinceDate = query.sinceDate;
        const mailbox = { uidValidity: 5, uidNext: 30 };
        if (pullCount++ > 0) {
          incrementalFromUid = query.fromUid;
          return { mailbox, scannedMaxUid: null, messages: [] };
        }
        const candidates = [
          makeMessage(10, '您账户0000于11月21日10:15银联扣款人民币21.50元，余额178.50元（银联在线支付，（特约）示例商户）', {
            date: '2026-11-21T02:16:00.000Z',
            from: '95555@message.cmbchina.com',
          }),
          makeMessage(11, '您账户1234于11月20日12:00在商户乙快捷支付20.00元，余额80.00。'),
        ];
        const matched = candidates.filter(message => query.headerFilter?.({
          uid: message.uid,
          internalDate: message.internalDate,
          headers: message.email,
        }));
        query.onProgress?.({ total: matched.length, processed: 0 });
        await query.onBatch?.([matched[0]], mailbox);
        query.onProgress?.({ total: 2, processed: 1 });
        // Verify batch 1 is already committed to SQLite before batch 2 even arrives
        countDuringSync = Number(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)'));
        progressDuringSync = (await mail.status()).progress;
        await query.onBatch?.([matched[1]], mailbox);
        query.onProgress?.({ total: 2, processed: 2 });
        return { mailbox, scannedMaxUid: 29, messages: [] };
      },
    };

    await db.prepare('INSERT INTO local_integration_state(id, value) VALUES(?, ?)').bind(
      'mail:qq:user@qq.com:INBOX:cmb-default',
      JSON.stringify({ uidValidity: 5, lastUid: 29, lastSyncAt: '2026-11-21T05:00:00.000Z', lastSuccessAt: '2026-11-21T05:00:00.000Z', lastError: null }),
    ).run();

    const mail = await createMailIntegration({
      db,
      dataDir: directory,
      config: { provider: 'qq', email: 'user@qq.com', host: 'imap.qq.com', port: 993, mailbox: 'INBOX', accountId: 'cmb-default', syncStartDate: '2026-11-19' },
      secretStore: secrets,
      transport,
    });

    const finalStatus = await mail.sync();
    expect(seenFromFilter).toBeUndefined();
    expect(seenFromUid).toBeUndefined();
    expect(seenSinceDate).toBe('2026-11-19');
    expect(countDuringSync).toBe(1);
    expect(progressDuringSync).toEqual({ total: 2, processed: 1, imported: 1 });
    expect(finalStatus.recordCount).toBe(2);
    expect(finalStatus.progress).toBeNull();
    const unionPay = await db.prepare("SELECT occurred_at, amount_cents, description FROM transactions WHERE amount_cents=2150").first<{
      occurred_at: string; amount_cents: number; description: string;
    }>();
    expect(unionPay).toEqual({
      occurred_at: '2026-11-21T02:15:00.000Z',
      amount_cents: 2150,
      description: '银联在线支付，（特约）示例商户',
    });

    const incrementalStatus = await mail.sync();
    expect(incrementalStatus.recordCount).toBe(2);
    expect(incrementalFromUid).toBe(29);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(2);

    // A successful full header scan repairs old cursors before normal UID incrementals resume.
    const stateRow = await db.prepare('SELECT value FROM local_integration_state WHERE id LIKE ?').bind('mail:%').first<{ value: string }>();
    expect(JSON.parse(stateRow!.value)).toMatchObject({ lastUid: 29, unfilteredBackfillComplete: true });
  });

  it('支持查看待处理邮件原文（含按需拉取与草稿提取）、手动补记入账以及全部忽略', async () => {
    const secrets = createMemorySecretStore();
    await secrets.set('user@qq.com', 'abcdefghijklmnop');
    const rawUnmatched1 = '您账户1234于10月29日17:00银联POS消费88.50元，余额1200.00。';
    const rawUnmatched2 = '您账户1234于10月26日15:42结息0.35元，余额1288.85。';

    const transport: MailTransport = {
      async testConnection() { return { uidValidity: 12, uidNext: 50 }; },
      async pullMessages() {
        return {
          mailbox: { uidValidity: 12, uidNext: 50 },
          scannedMaxUid: 41,
          messages: [
            makeMessage(40, rawUnmatched1, { subject: '一卡通账户变动通知', date: '2026-10-29T17:00:00+08:00' }),
            makeMessage(41, rawUnmatched2, { subject: '一卡通账户变动通知', date: '2026-10-26T15:42:00+08:00' }),
          ],
        };
      },
      async fetchMessage(_opts, uidValidity, uid) {
        if (uidValidity === 12 && uid === 40) return makeMessage(40, rawUnmatched1, { date: '2026-10-29T17:00:00+08:00' });
        return null;
      },
    };

    const mail = await createMailIntegration({
      db,
      dataDir: directory,
      config: { provider: 'qq', email: 'user@qq.com', host: 'imap.qq.com', port: 993, mailbox: 'INBOX', accountId: 'cmb-default', syncStartDate: '2026-10-01' },
      secretStore: secrets,
      transport,
    });
    await mail.sync();

    // Simulate legacy invalid row without cached body_preview -> on-demand fetch populates it
    await db.prepare('UPDATE local_mail_messages SET body_preview=NULL WHERE uid=40').run();
    const detailRes = await mail.routes.request('/mail/issues/12/40', {}, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json() as { data: { body: string; draft: { amount: string; occurredAt: string; kind: string } } }).data;
    expect(detail.body).toContain('银联POS消费88.50元');
    expect(detail.draft).toMatchObject({ amount: '88.50', occurredAt: '2026-10-29T17:00:00+08:00', kind: 'expense' });

    // Record transaction directly from issue -> resolves issue and clears body_preview
    const recordRes = await mail.routes.request('/mail/issues/12/40/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        occurredAt: '2026-10-29T17:00:00+08:00',
        kind: 'expense',
        amount: '88.50',
        description: '银联POS消费',
      }),
    }, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(recordRes.status).toBe(201);
    const recorded = (await recordRes.json() as { data: { transaction: { amountCents: number }; status: { issues: unknown[]; recordCount: number } } }).data;
    expect(recorded.transaction.amountCents).toBe(8850);
    expect(recorded.status.recordCount).toBe(1);
    expect(recorded.status.issues).toHaveLength(1);
    expect(await db.prepare('SELECT body_preview FROM local_mail_messages WHERE uid=40').first('body_preview')).toBeNull();

    // Dismiss all remaining issues
    const dismissAllRes = await mail.routes.request('/mail/issues/dismiss-all', { method: 'POST', body: '{}' }, { DB: db, OWNER_ACCESS_KEY: 'test' });
    expect(dismissAllRes.status).toBe(200);
    const afterAll = (await dismissAllRes.json() as { data: { issues: unknown[] } }).data;
    expect(afterAll.issues).toHaveLength(0);
  });
});
