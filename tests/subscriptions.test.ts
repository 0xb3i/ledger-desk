import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import type { Backup, BackupRestoreResult, Subscription, SubscriptionInput, SubscriptionList, SubscriptionReminders } from '../src/shared/contracts';
import { addCycles, chargesBetween, monthlyEquivalentCents, needsReminder, nextOccurrence, subscriptionSchedule } from '../src/shared/subscriptions';
import type { SubscriptionSuggestion } from '../src/shared/subscriptions';
import { normalizeInput } from '../src/server/ledger/domain';
import { createTransaction } from '../src/server/ledger/repository';
import { guessCycle } from '../src/server/subscriptions';

describe('订阅周期推算', () => {
  it('从账单日期推断周期：漏记几个月仍按每月，季度、年、周各自识别', () => {
    expect(guessCycle(['2026-05-15', '2026-07-14', '2026-08-16', '2026-10-13', '2026-11-15'])).toBe('monthly');
    expect(guessCycle(['2026-02-18', '2026-03-18', '2026-05-18', '2026-06-18'])).toBe('monthly');
    expect(guessCycle(['2026-01-15', '2026-04-15', '2026-10-14'])).toBe('quarterly');
    expect(guessCycle(['2024-03-01', '2025-03-02', '2026-03-01'])).toBe('yearly');
    expect(guessCycle(['2026-11-02', '2026-11-09', '2026-11-23'])).toBe('weekly');
    expect(guessCycle(['2026-11-02'])).toBe('monthly');
  });
  it('按月保留几号，小月取月末且不逐期漂移', () => {
    expect(addCycles('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(addCycles('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(addCycles('2024-02-29', 'yearly', 1)).toBe('2025-02-28');
    expect(addCycles('2026-11-30', 'quarterly', 1)).toBe('2027-02-28');
    expect(addCycles('2026-11-23', 'weekly', 2)).toBe('2026-12-07');
  });
  it('自动续期推到不早于今天的第一期', () => {
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-03-01')).toBe('2026-03-31');
    expect(nextOccurrence('2026-11-23', 'monthly', '2026-11-23')).toBe('2026-11-23');
    expect(nextOccurrence('2020-05-10', 'yearly', '2026-11-23')).toBe('2027-05-10');
    expect(nextOccurrence('2026-11-01', 'weekly', '2026-11-23')).toBe('2026-11-29');
  });
  it('折算月额、提醒状态与本月剩余扣费', () => {
    expect(monthlyEquivalentCents(1200, 'weekly')).toBe(5200);
    expect(monthlyEquivalentCents(68_800, 'yearly')).toBe(5733);
    const base = { amountCents: 1000, cycle: 'monthly' as const, autoRenew: true, remindDays: 3, endedAt: null, endDate: null };
    expect(subscriptionSchedule({ ...base, nextDueDate: '2026-11-25' }, '2026-11-23')).toMatchObject({ dueDate: '2026-11-25', daysLeft: 2, state: 'soon' });
    expect(subscriptionSchedule({ ...base, nextDueDate: '2026-11-30' }, '2026-11-23')).toMatchObject({ daysLeft: 7, state: 'upcoming' });
    expect(subscriptionSchedule({ ...base, nextDueDate: '2026-11-20' }, '2026-11-23')).toMatchObject({ dueDate: '2026-12-20', state: 'upcoming' });
    expect(subscriptionSchedule({ ...base, autoRenew: false, nextDueDate: '2026-11-20' }, '2026-11-23')).toMatchObject({ dueDate: '2026-11-20', daysLeft: -3, state: 'overdue' });
    expect(subscriptionSchedule({ ...base, nextDueDate: '2026-11-25', endedAt: '2026-11-01T00:00:00.000Z' }, '2026-11-23').state).toBe('ended');
    expect(chargesBetween({ ...base, cycle: 'weekly', nextDueDate: '2026-11-02' }, '2026-11-23', '2026-11-30')).toBe(2000);
    expect(chargesBetween({ ...base, autoRenew: false, nextDueDate: '2026-11-20' }, '2026-11-23', '2026-11-30')).toBe(1000);
    expect(chargesBetween({ ...base, autoRenew: false, nextDueDate: '2026-12-02' }, '2026-11-23', '2026-11-30')).toBe(0);
  });
  it('到期日：用到这天为止，这天及以后不再扣费', () => {
    const rent = { amountCents: 320_000, cycle: 'monthly' as const, autoRenew: true, remindDays: 7, endedAt: null, nextDueDate: '2026-12-15' };
    // 房租交到 12/15：12/15 那期不再扣，到期前仍在进行中，快到期时提醒
    expect(subscriptionSchedule({ ...rent, endDate: '2026-12-15' }, '2026-11-23')).toMatchObject({ dueDate: '2026-12-15', daysLeft: 22, state: 'ending', isFinal: false });
    // 只有手动付款的才提醒
    expect(needsReminder({ ...subscriptionSchedule({ ...rent, endDate: '2026-12-15' }, '2026-12-09'), remindDays: 7, autoRenew: false })).toBe(true);
    expect(needsReminder({ ...subscriptionSchedule({ ...rent, endDate: '2026-12-15' }, '2026-12-09'), remindDays: 7, autoRenew: true })).toBe(false);
    expect(subscriptionSchedule({ ...rent, endDate: '2026-12-15' }, '2026-12-15').state).toBe('finished');
    expect(chargesBetween({ ...rent, endDate: '2026-12-15' }, '2026-11-23', '2026-12-31')).toBe(0);
    // 续到明年 3/15：2/15 是最后一次扣费
    expect(subscriptionSchedule({ ...rent, endDate: '2027-03-15' }, '2026-11-23')).toMatchObject({ dueDate: '2026-12-15', state: 'upcoming', isFinal: false });
    expect(subscriptionSchedule({ ...rent, endDate: '2027-03-15' }, '2027-01-20')).toMatchObject({ dueDate: '2027-02-15', isFinal: true });
    const weekly = { amountCents: 1000, cycle: 'weekly' as const, autoRenew: true, remindDays: 3, endedAt: null, nextDueDate: '2026-11-02' };
    expect(subscriptionSchedule({ ...weekly, endDate: '2026-11-30' }, '2026-11-23')).toMatchObject({ dueDate: '2026-11-23', state: 'soon', isFinal: true });
    expect(chargesBetween({ ...weekly, endDate: '2026-11-30' }, '2026-11-23', '2026-12-31')).toBe(1000);
  });
});

let db: LocalDatabase, directory: string, cookie: string;
const origin = 'https://subscriptions.test';
const ownerKey = 'pd_owner_' + 'subscription-isolated-test'.repeat(4);
const input = (extra: Partial<SubscriptionInput> = {}): SubscriptionInput => ({
  name: '房租', category: 'housing', amount: '3200', cycle: 'monthly', nextDueDate: '2026-11-26', autoRenew: true, remindDays: 7, note: '', ...extra,
});
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, database = db) {
  return app.request(origin + '/api' + path, { method,
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { DB: database, OWNER_ACCESS_KEY: ownerKey } as unknown as Env);
}
async function read<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function create(extra: Partial<SubscriptionInput> = {}) {
  return read<Subscription>(await request('/subscriptions', 'POST', { ...input(extra), id: crypto.randomUUID() }), 201);
}
async function login(database: LocalDatabase) {
  const response = await app.request(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ accessKey: ownerKey }) }, { DB: database, OWNER_ACCESS_KEY: ownerKey } as unknown as Env);
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';')[0];
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T04:00:00Z')); // 上海时间 2026-11-23 12:00
  directory = await mkdtemp(join(tmpdir(), 'qingji-subscriptions-test-'));
  db = new LocalDatabase(join(directory, 'ledger.sqlite'));
  await applyMigrations(db, resolve('migrations'));
  cookie = await login(db);
});
afterEach(async () => { vi.useRealTimers(); db.close(); await rm(directory, { recursive: true, force: true }); });

describe('订阅与固定开销 API', () => {
  it('需要会话和同源 Origin', async () => {
    const item = await create();
    expect((await request('/subscriptions', 'GET', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request('/subscriptions/reminders', 'GET', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request('/subscriptions', 'POST', { ...input(), id: crypto.randomUUID() }, { Origin: 'https://other.test' })).status).toBe(403);
    expect((await request(`/subscriptions/${item.id}/end`, 'POST', { version: 1 }, { Origin: '' })).status).toBe(403);
  });

  it('添加后按到期日排序，并给出合计与本月剩余扣费', async () => {
    await create({ name: 'iCloud+', category: 'software', amount: '21', nextDueDate: '2026-12-05', remindDays: 3 });
    await create();
    await create({ name: '域名', category: 'software', amount: '79', cycle: 'yearly', nextDueDate: '2027-03-01', autoRenew: false });
    const list = await read<SubscriptionList>(await request('/subscriptions'));
    expect(list.today).toBe('2026-11-23');
    expect(list.items.map(item => item.name)).toEqual(['房租', 'iCloud+', '域名']);
    expect(list.items[0]).toMatchObject({ amountCents: 320_000, dueDate: '2026-11-26', daysLeft: 3, state: 'soon', monthlyCents: 320_000 });
    expect(list.items[1]).toMatchObject({ state: 'upcoming', daysLeft: 12 });
    expect(list.counts).toEqual({ active: 3, ended: 0 });
    expect(list.monthlyCents).toBe(320_000 + 2_100 + 658);
    expect(list.yearlyCents).toBe(320_000 * 12 + 2_100 * 12 + 7_900);
    expect(list.remainingThisMonthCents).toBe(320_000);
    expect((await read<SubscriptionList>(await request('/subscriptions?search=icloud'))).items.map(item => item.name)).toEqual(['iCloud+']);
  });

  it('重复提交同一个添加请求是幂等的，内容不同则拒绝', async () => {
    const id = crypto.randomUUID();
    const first = await read<Subscription>(await request('/subscriptions', 'POST', { ...input(), id }), 201);
    expect(await read<Subscription>(await request('/subscriptions', 'POST', { ...input(), id }))).toEqual(first);
    expect((await request('/subscriptions', 'POST', { ...input({ amount: '3300' }), id })).status).toBe(409);
  });

  it('拒绝无效日期、金额和提醒天数', async () => {
    for (const bad of [{ nextDueDate: '2026-02-30' }, { nextDueDate: '1999-12-31' }, { amount: '0' }, { amount: '-5' }, { remindDays: 61 }, { name: ' ' },
      { url: 'javascript:alert(1)' }, { url: 'https://user:pass@example.com/' }, { url: 'ftp://example.com/' }]) {
      expect((await request('/subscriptions', 'POST', { ...input(), ...bad, id: crypto.randomUUID() })).status).toBe(422);
    }
  });

  it('编辑需要匹配版本，冲突时返回 409', async () => {
    const item = await create();
    const updated = await read<Subscription>(await request(`/subscriptions/${item.id}`, 'PUT', { ...input({ amount: '3500', remindDays: 3 }), version: 1 }));
    expect(updated).toMatchObject({ amountCents: 350_000, remindDays: 3, version: 2, state: 'soon', url: '' });
    expect(await read<Subscription>(await request(`/subscriptions/${item.id}`, 'PUT', { ...input({ url: ' https://example.com/console ' }), version: 2 })))
      .toMatchObject({ url: 'https://example.com/console', version: 3 });
    expect((await request(`/subscriptions/${item.id}`, 'PUT', { ...input(), version: 1 })).status).toBe(409);
    expect((await request(`/subscriptions/${crypto.randomUUID()}`, 'PUT', { ...input(), version: 1 })).status).toBe(404);
  });

  it('铃铛只列出手动付款里进入提醒窗口或逾期的项目', async () => {
    await create({ name: '房租', autoRenew: false });
    await create({ name: '健身房', amount: '199', nextDueDate: '2026-12-20' });
    await create({ name: '视频会员', category: 'membership', amount: '25', nextDueDate: '2026-11-20', autoRenew: false });
    await create({ name: '宽带', category: 'utility', amount: '100', nextDueDate: '2026-11-23', remindDays: 0, autoRenew: false });
    const reminders = await read<SubscriptionReminders>(await request('/subscriptions/reminders'));
    expect(reminders.items.map(item => [item.name, item.state, item.daysLeft])).toEqual([
      ['视频会员', 'overdue', -3], ['宽带', 'soon', 0], ['房租', 'soon', 3],
    ]);
  });

  it('本期已付：把当前这一期往后推一个周期，提醒随之消失', async () => {
    const manual = await create({ name: '视频会员', amount: '25', nextDueDate: '2026-11-20', autoRenew: false });
    const renewed = await read<Subscription>(await request(`/subscriptions/${manual.id}/renew`, 'POST', { version: 1 }));
    expect(renewed).toMatchObject({ nextDueDate: '2026-12-20', state: 'upcoming', version: 2 });
    const rent = await create();
    expect(await read<Subscription>(await request(`/subscriptions/${rent.id}/renew`, 'POST', { version: 1 }))).toMatchObject({ dueDate: '2026-12-26', state: 'upcoming' });
    expect((await request(`/subscriptions/${rent.id}/renew`, 'POST', { version: 1 })).status).toBe(409);
    expect((await read<SubscriptionReminders>(await request('/subscriptions/reminders'))).items).toEqual([]);
  });

  it('不再续费：到期日设为下次扣费日，到期前仍在进行中并提醒，过了到期日归入已到期，可恢复续费', async () => {
    const item = await create({ autoRenew: false });
    const ending = await read<Subscription>(await request(`/subscriptions/${item.id}/end`, 'POST', { version: 1 }));
    expect(ending).toMatchObject({ endDate: '2026-11-26', dueDate: '2026-11-26', state: 'ending', daysLeft: 3 });
    expect((await read<SubscriptionReminders>(await request('/subscriptions/reminders'))).items.map(i => i.state)).toEqual(['ending']);
    expect(await read<SubscriptionList>(await request('/subscriptions'))).toMatchObject({ counts: { active: 1, ended: 0 }, remainingThisMonthCents: 0 });
    expect((await request(`/subscriptions/${item.id}/renew`, 'POST', { version: 2 })).status).toBe(409);

    vi.setSystemTime(new Date('2026-11-26T04:00:00Z'));
    const list = await read<SubscriptionList>(await request('/subscriptions'));
    expect(list).toMatchObject({ items: [], counts: { active: 0, ended: 1 }, monthlyCents: 0 });
    expect((await read<SubscriptionList>(await request('/subscriptions?status=ended'))).items[0]).toMatchObject({ id: item.id, state: 'finished' });
    expect((await read<SubscriptionReminders>(await request('/subscriptions/reminders'))).items).toEqual([]);
    expect((await request(`/subscriptions/${item.id}/end`, 'POST', { version: 2 })).status).toBe(409);
    const restored = await read<Subscription>(await request(`/subscriptions/${item.id}/restore`, 'POST', { version: 2 }));
    expect(restored).toMatchObject({ endDate: null, state: 'soon', dueDate: '2026-11-26', version: 3 });
  });

  it('到期日可以填任意日期，也能在编辑时延后或清空；旧版本手动结束的项目可以恢复', async () => {
    expect(await create({ nextDueDate: '2026-12-15', endDate: '2026-12-15' })).toMatchObject({ state: 'ending', dueDate: '2026-12-15' });
    expect(await create({ nextDueDate: '2026-12-15', endDate: '2026-11-01' })).toMatchObject({ state: 'finished' });
    const item = await create({ nextDueDate: '2026-12-15', endDate: '2027-03-15' });
    expect(item).toMatchObject({ state: 'upcoming', dueDate: '2026-12-15', isFinal: false });
    const cleared = await read<Subscription>(await request(`/subscriptions/${item.id}`, 'PUT', { ...input({ nextDueDate: '2026-12-15', endDate: null }), version: 1 }));
    expect(cleared).toMatchObject({ endDate: null, state: 'upcoming' });
    await db.prepare("UPDATE subscriptions SET ended_at='2026-11-01T00:00:00.000Z' WHERE id=?").bind(item.id).run();
    expect((await read<Subscription>(await request(`/subscriptions/${item.id}`))).state).toBe('ended');
    expect(await read<Subscription>(await request(`/subscriptions/${item.id}/restore`, 'POST', { version: 2 }))).toMatchObject({ endedAt: null, state: 'upcoming' });
  });

  it('从账单识别可能的订阅：确认时选扣款方式，忽略后不再推荐，都不改动账单', async () => {
    const bill = (description: string, amount: string, occurredAt: string, extra: { isFixed?: boolean; categoryId?: string } = {}) =>
      createTransaction(db, normalizeInput({ occurredAt, description, counterparty: '财付通', amount, kind: 'expense', accountId: 'cmb-default',
        categoryId: extra.categoryId ?? 'other', isFixed: extra.isFixed ?? false, note: '' }), { key: crypto.randomUUID(), scope: 'manual', source: 'manual' });
    // 标记为固定支出的房租：漏记一个月也按每月识别
    for (const date of ['2026-07-14', '2026-09-13', '2026-10-15', '2026-11-14']) await bill('房租', '3200', `${date}T10:00:00+08:00`, { isFixed: true, categoryId: 'housing' });
    // 没标固定支出、但每月同一对象同样金额：识别
    for (const date of ['2026-08-20', '2026-09-20', '2026-10-20']) await bill('iCloud 存储', '21', `${date}T08:00:00+08:00`);
    // 同一对象但金额不同、间隔不规律、或早已停掉的：不识别
    for (const [date, amount] of [['2026-11-01', '30'], ['2026-11-02', '30'], ['2026-11-05', '30'], ['2026-11-12', '30']]) await bill('食堂', amount, `${date}T12:00:00+08:00`);
    for (const [date, amount] of [['2026-08-03', '120'], ['2026-09-03', '95'], ['2026-10-03', '140']]) await bill('超市', amount, `${date}T18:00:00+08:00`);
    for (const date of ['2025-12-01', '2026-01-01', '2026-02-01']) await bill('旧会员', '15', `${date}T09:00:00+08:00`);
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM transactions').first<{ n: number }>())!.n;

    const suggestions = async () => (await read<{ items: SubscriptionSuggestion[] }>(await request('/subscriptions/suggestions'))).items;
    const items = await suggestions();
    expect(items.map(item => [item.name, item.category, item.amountCents, item.cycle, item.nextDueDate, item.autoRenew, item.count])).toEqual([
      ['房租', 'housing', 320_000, 'monthly', '2026-12-14', false, 4],
      ['iCloud 存储', 'software', 2_100, 'monthly', '2026-12-20', true, 3],
    ]);
    const rent = await read<Subscription>(await request('/subscriptions/suggestions/accept', 'POST', { key: items[0].key, autoRenew: false }), 201);
    expect(rent).toMatchObject({ name: '房租', autoRenew: false, sourceKey: items[0].key, state: 'upcoming' });
    expect((await request('/subscriptions/suggestions/accept', 'POST', { key: items[0].key, autoRenew: false })).status).toBe(409);
    expect(await read(await request('/subscriptions/suggestions/dismiss', 'POST', { key: items[1].key }))).toEqual({ dismissed: true });
    expect(await suggestions()).toEqual([]);
    // 加入后改名、甚至不再续费，也不会再被推荐
    await read(await request(`/subscriptions/${rent.id}`, 'PUT', { ...input({ name: '公寓租金', nextDueDate: '2026-12-14', autoRenew: false }), version: 1 }));
    await read(await request(`/subscriptions/${rent.id}/end`, 'POST', { version: 2 }));
    expect(await suggestions()).toEqual([]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM transactions').first<{ n: number }>())!.n).toBe(before);
  });

  it('自动扣款的订阅不进铃铛，手动付款的才提醒', async () => {
    await create({ name: 'iCloud', category: 'software', amount: '6', nextDueDate: '2026-11-24', autoRenew: true });
    await create({ name: '房租', nextDueDate: '2026-11-26', autoRenew: false });
    expect((await read<SubscriptionReminders>(await request('/subscriptions/reminders'))).items.map(item => item.name)).toEqual(['房租']);
  });

  it('备份导出订阅，恢复到新库后重复恢复会跳过，内容冲突时整体拒绝', async () => {
    const item = await create({ note: '押一付三', url: 'https://example.com/billing' });
    const backup = await read<Extract<Backup, { schemaVersion: 7 }>>(await request('/backup'));
    expect(backup.subscriptions).toEqual([expect.objectContaining({ id: item.id, nextDueDate: '2026-11-26', autoRenew: true, note: '押一付三', url: 'https://example.com/billing' })]);
    expect(backup.subscriptions![0]).not.toHaveProperty('dueDate');

    const otherDirectory = await mkdtemp(join(tmpdir(), 'qingji-subscriptions-restore-'));
    const other = new LocalDatabase(join(otherDirectory, 'ledger.sqlite'));
    try {
      await applyMigrations(other, resolve('migrations'));
      const saved = cookie;
      cookie = await login(other);
      const first = await read<BackupRestoreResult>(await request('/backup/restore', 'POST', backup, {}, other));
      expect(first).toMatchObject({ subscriptionsInserted: 1, subscriptionsSkipped: 0 });
      expect(await read<BackupRestoreResult>(await request('/backup/restore', 'POST', backup, {}, other))).toMatchObject({ subscriptionsInserted: 0, subscriptionsSkipped: 1 });
      const restored = await read<SubscriptionList>(await request('/subscriptions', 'GET', undefined, {}, other));
      expect(restored.items[0]).toMatchObject({ id: item.id, name: '房租', state: 'soon' });
      const conflicting = { ...backup, subscriptions: [{ ...backup.subscriptions![0], amountCents: 1 }] };
      expect((await request('/backup/restore', 'POST', conflicting, {}, other)).status).toBe(409);
      const { subscriptions: _, ...older } = backup;
      expect(await read<BackupRestoreResult>(await request('/backup/restore', 'POST', older, {}, other))).toMatchObject({ subscriptionsInserted: 0, subscriptionsSkipped: 0 });
      cookie = saved;
    } finally { other.close(); await rm(otherDirectory, { recursive: true, force: true }); }
  });
});
