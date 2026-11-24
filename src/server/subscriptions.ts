import { Hono } from 'hono';
import { z } from 'zod';
import {
  SUBSCRIPTION_CATEGORIES, SUBSCRIPTION_CYCLES, addCycles, addDays, chargesBetween, daysBetween, isActive, isCalendarDate, needsReminder, nextOccurrence,
  subscriptionSchedule, yearlyCents,
  type Subscription, type SubscriptionCategory, type SubscriptionCycle, type SubscriptionSuggestion, type SubscriptionSuggestionList,
  type SubscriptionList, type SubscriptionReminders,
} from '../shared/subscriptions';
import type { ApiEnv } from './types';
import { ApiError } from './errors';
import { digest } from './security';
import { MAX_CENTS, normalizeDate, parseAmount, versionSchema } from './ledger/domain';
import { urlSchema } from './wishlist';

const itemId = z.uuid();
const nameSchema = z.string().trim().min(1).max(100);
const noteSchema = z.string().trim().max(500);
const calendarDate = z.string().refine(isCalendarDate, '日期须为 2000–2199 年之间的有效日期（YYYY-MM-DD）。');
const remindDaysSchema = z.number().int().min(0).max(60);
const sourceKeySchema = z.string().min(1).max(200);
const inputSchema = z.object({
  name: nameSchema, category: z.enum(SUBSCRIPTION_CATEGORIES).default('other'), amount: z.string().trim().max(20),
  cycle: z.enum(SUBSCRIPTION_CYCLES), nextDueDate: calendarDate, endDate: calendarDate.nullable().default(null),
  autoRenew: z.boolean().default(true), remindDays: remindDaysSchema.default(7), note: noteSchema.default(''), url: urlSchema.default(''),
});
const timestamp = z.string().max(40).transform(normalizeDate);
/** 备份里的订阅：只保存原始字段，推算字段在读取时重新计算；较早的备份没有到期日与来源 */
export const subscriptionBackupSchema = z.object({
  id: itemId, name: nameSchema, category: z.enum(SUBSCRIPTION_CATEGORIES), amountCents: z.number().int().min(1).max(MAX_CENTS),
  cycle: z.enum(SUBSCRIPTION_CYCLES), nextDueDate: calendarDate, endDate: calendarDate.nullable().optional().default(null),
  autoRenew: z.boolean(), remindDays: remindDaysSchema, note: noteSchema, url: urlSchema.optional().default(''), sourceKey: sourceKeySchema.nullable().optional().default(null),
  createdAt: timestamp, updatedAt: timestamp, endedAt: timestamp.nullable(), version: versionSchema.shape.version,
});
export type StoredSubscription = z.infer<typeof subscriptionBackupSchema>;

export interface SubscriptionRow {
  id: string; name: string; category: Subscription['category']; amount_cents: number; cycle: Subscription['cycle'];
  next_due_date: string; end_date: string | null; auto_renew: number; remind_days: number; note: string; url: string | null; source_key: string | null;
  created_at: string; updated_at: string; ended_at: string | null; version: number; create_payload_hash: string | null;
}
export const subscriptionColumns: Record<string, keyof StoredSubscription> = {
  id: 'id', name: 'name', category: 'category', amount_cents: 'amountCents', cycle: 'cycle', next_due_date: 'nextDueDate',
  end_date: 'endDate', auto_renew: 'autoRenew', remind_days: 'remindDays', note: 'note', url: 'url', source_key: 'sourceKey',
  created_at: 'createdAt', updated_at: 'updatedAt', ended_at: 'endedAt', version: 'version',
};
export function toStoredSubscription(row: SubscriptionRow): StoredSubscription {
  return { id: row.id, name: row.name, category: row.category, amountCents: row.amount_cents, cycle: row.cycle,
    nextDueDate: row.next_due_date, endDate: row.end_date ?? null, autoRenew: row.auto_renew === 1, remindDays: row.remind_days,
    note: row.note, url: row.url ?? '', sourceKey: row.source_key ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, endedAt: row.ended_at, version: row.version };
}
export function toSubscription(row: SubscriptionRow, today: string): Subscription {
  const stored = toStoredSubscription(row);
  return { ...stored, ...subscriptionSchedule(stored, today) };
}

const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export const shanghaiToday = (now = new Date()) => todayFormatter.format(now);
const monthEnd = (today: string) => addDays(addCycles(`${today.slice(0, 7)}-01`, 'monthly', 1), -1);
const byDue = (a: Subscription, b: Subscription) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
/** 已到期列表：按到期日（旧版本手动结束的按结束时间），新的在前 */
const endedAt = (item: Subscription) => item.endedAt ?? `${item.endDate}T23:59:59.999Z`;

function normalizedInput(input: z.infer<typeof inputSchema>) {
  return { name: input.name, category: input.category, amountCents: parseAmount(input.amount), cycle: input.cycle,
    nextDueDate: input.nextDueDate, endDate: input.endDate, autoRenew: input.autoRenew, remindDays: input.remindDays, note: input.note, url: input.url };
}
async function changed(db: D1Database, id: string, row: SubscriptionRow | null): Promise<Subscription> {
  if (row) return toSubscription(row, shanghaiToday());
  const exists = await db.prepare('SELECT id FROM subscriptions WHERE id=?').bind(id).first();
  if (!exists) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', '这项订阅不存在。');
  throw new ApiError(409, 'SUBSCRIPTION_VERSION_CONFLICT', '这项订阅已发生变化，请刷新后重新操作。');
}
async function allSubscriptions(db: D1Database, today: string): Promise<Subscription[]> {
  const result = await db.prepare('SELECT * FROM subscriptions ORDER BY next_due_date,id LIMIT 2000').all<SubscriptionRow>();
  return (result.results ?? []).map(row => toSubscription(row, today));
}

/* ---------- 从账单识别可能的订阅 ---------- */

/** 名称归一：去掉月份、期数、空白与标点，「房租11月」与「房租 12 月」视为同一项 */
export const subscriptionNameKey = (value: string) => value.toLowerCase()
  .replace(/\d+\s*(?:月份?|期|年)?/g, '').replace(/[\s·\-_/\\|（）()【】[\]{}:：,，.。、'"“”‘’!！?？*+#@&]+/g, '').slice(0, 150);
const CATEGORY_HINTS: [SubscriptionCategory, RegExp][] = [
  ['housing', /房租|租金|物业|房东|公寓|住房/],
  ['insurance', /保险|保费|寿险|医疗险|意外险/],
  ['utility', /话费|电费|水费|燃气|宽带|网费|流量|移动|联通|电信|国家电网/],
  ['membership', /会员|vip|视频|爱奇艺|优酷|腾讯视频|哔哩|bilibili|芒果|网易云|qq音乐|健身|京东plus|88vip/],
  ['software', /icloud|apple|云上贵州|云上艾珀|chatgpt|openai|claude|anthropic|github|notion|spotify|netflix|youtube|网盘|订阅|软件|adobe|microsoft|office|域名|服务器|云服务/],
];
function guessCategory(text: string, ledgerCategory: string | null): SubscriptionCategory {
  const lower = text.toLowerCase();
  for (const [category, pattern] of CATEGORY_HINTS) if (pattern.test(lower)) return category;
  return ledgerCategory === 'housing' ? 'housing' : 'other';
}
/** 周期匹配：取让每个相邻间隔都接近整数倍的最长周期，漏记几期（间隔是两三个月）也不会误判；没有合适的返回 null */
const CYCLE_DAYS: [SubscriptionCycle, number][] = [['yearly', 365.25], ['semiannual', 182.6], ['quarterly', 91.3], ['monthly', 30.44], ['weekly', 7]];
function fitCycle(dates: string[]): SubscriptionCycle | null {
  const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date));
  return CYCLE_DAYS.find(([, days]) => gaps.every(gap => { const n = Math.round(gap / days); return n >= 1 && Math.abs(gap / days - n) <= 0.3; }))?.[0] ?? null;
}
/** 推断周期：先按整数倍匹配，都不合适时按间隔中位数；只有一笔时按每月 */
export function guessCycle(dates: string[]): SubscriptionCycle {
  if (dates.length < 2) return 'monthly';
  const fit = fitCycle(dates);
  if (fit) return fit;
  const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date)).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median <= 10 ? 'weekly' : median <= 45 ? 'monthly' : median <= 120 ? 'quarterly' : median <= 240 ? 'semiannual' : 'yearly';
}
const cycleDays = (cycle: SubscriptionCycle) => CYCLE_DAYS.find(([value]) => value === cycle)![1];
interface BillRow { occurred_at: string; amount_cents: number; description: string; counterparty: string; category_id: string | null; is_fixed: number }

/**
 * 识别可能的订阅：最近两年已确认的支出，按名称（去掉月份数字与标点）和金额归组，
 * 至少 3 笔、间隔都接近同一周期的整数倍，且最近一笔没有断档太久。
 * 标记为固定支出的账单只按名称归组（水电这类金额会变），2 笔即可，周期对不齐时按间隔中位数。
 * 已在订阅里（同来源或同名进行中）和被点过「不是订阅」的不再出现。
 */
export async function subscriptionSuggestions(db: D1Database, today: string): Promise<SubscriptionSuggestion[]> {
  const since = `${addDays(today, -800)}T00:00:00.000Z`;
  const [bills, existing, dismissed] = await Promise.all([
    db.prepare(`SELECT occurred_at,amount_cents,description,counterparty,category_id,is_fixed FROM transactions
      WHERE kind='expense' AND deleted_at IS NULL AND review_status='confirmed' AND occurred_at>=? ORDER BY occurred_at,id`).bind(since).all<BillRow>(),
    allSubscriptions(db, today),
    db.prepare('SELECT key FROM subscription_dismissals').all<{ key: string }>(),
  ]);
  const groups = new Map<string, BillRow[]>();
  for (const row of bills.results ?? []) {
    const name = subscriptionNameKey(row.description || row.counterparty);
    if (!name) continue;
    const key = row.is_fixed ? `bill:${name}` : `bill:${name}:${row.amount_cents}`;
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const skip = new Set((dismissed.results ?? []).map(row => row.key));
  // 已在订阅里：从账单识别来的按来源名称算（改过名也认得），手动添加的按同名进行中的算
  const sourceName = (key: string) => key.replace(/^(?:fixed|bill):/, '').replace(/:\d+$/, '');
  const known = new Set([...existing.flatMap(item => item.sourceKey ? [sourceName(item.sourceKey)] : []),
    ...existing.filter(isActive).map(item => subscriptionNameKey(item.name))]);
  const result: SubscriptionSuggestion[] = [];
  for (const [key, rows] of groups) {
    const nameKey = subscriptionNameKey(rows[0].description || rows[0].counterparty);
    if (skip.has(key) || known.has(nameKey)) continue;
    const fixed = rows.some(row => row.is_fixed);
    const dates = [...new Set(rows.map(row => todayFormatter.format(new Date(row.occurred_at))))];
    if (dates.length < (fixed ? 2 : 3)) continue;
    const fit = fitCycle(dates);
    if (!fit && !fixed) continue;
    const cycle = fit ?? guessCycle(dates), lastPaidAt = dates[dates.length - 1];
    if (cycle === 'weekly' && !fixed && dates.length < 4) continue;
    // 最近一笔距今超过两个半周期，多半已经停了
    if (daysBetween(lastPaidAt, today) > cycleDays(cycle) * 2.5) continue;
    const latest = rows[rows.length - 1];
    const name = (latest.description || latest.counterparty).trim().slice(0, 100);
    const category = guessCategory(`${name} ${latest.counterparty}`, latest.category_id);
    result.push({ key, name, category, amountCents: latest.amount_cents, cycle,
      nextDueDate: nextOccurrence(addCycles(lastPaidAt, cycle, 1), cycle, today), remindDays: category === 'housing' ? 7 : 3,
      autoRenew: category !== 'housing', count: rows.length, lastPaidAt });
  }
  return result.sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name, 'zh-CN'));
}

export const subscriptionRoutes = new Hono<ApiEnv>();
subscriptionRoutes.get('/subscriptions', async c => {
  const { status, search } = z.object({
    status: z.enum(['active', 'ended']).default('active'), search: z.string().trim().max(100).default(''),
  }).parse(c.req.query());
  const today = shanghaiToday();
  const all = await allSubscriptions(c.env.DB, today);
  const activeItems = all.filter(isActive), endedItems = all.filter(item => !isActive(item)).sort((a, b) => endedAt(b).localeCompare(endedAt(a)));
  // 字面子串搜索：名称或备注
  const needle = search.toLowerCase();
  const matches = (item: Subscription) => !needle || item.name.toLowerCase().includes(needle) || item.note.toLowerCase().includes(needle);
  const until = monthEnd(today);
  const data: SubscriptionList = {
    items: (status === 'active' ? activeItems.sort(byDue) : endedItems).filter(matches), today,
    counts: { active: activeItems.length, ended: endedItems.length },
    monthlyCents: activeItems.reduce((sum, item) => sum + item.monthlyCents, 0),
    yearlyCents: activeItems.reduce((sum, item) => sum + yearlyCents(item.amountCents, item.cycle), 0),
    remainingThisMonthCents: activeItems.reduce((sum, item) => sum + chargesBetween(item, today, until), 0),
    byCategory: SUBSCRIPTION_CATEGORIES.map(category => {
      const items = activeItems.filter(item => item.category === category);
      return { category, monthlyCents: items.reduce((sum, item) => sum + item.monthlyCents, 0), count: items.length };
    }).filter(group => group.count > 0).sort((a, b) => b.monthlyCents - a.monthlyCents),
  };
  return c.json({ data });
});
/* 右上角铃铛：手动付款的订阅里，快到付款日、逾期，或快到期且不再续费的，最近的排在前面 */
subscriptionRoutes.get('/subscriptions/reminders', async c => {
  const today = shanghaiToday();
  const items = (await allSubscriptions(c.env.DB, today)).filter(needsReminder).sort(byDue);
  const data: SubscriptionReminders = { items, today };
  return c.json({ data });
});
/* 可能的订阅：只读账单，不改动账单 */
subscriptionRoutes.get('/subscriptions/suggestions', async c => {
  const data: SubscriptionSuggestionList = { items: await subscriptionSuggestions(c.env.DB, shanghaiToday()) };
  return c.json({ data });
});
/* 确认建议：按服务端重新识别的结果新建订阅，扣款方式由用户选择；建议已失效或已加入时返回 409，不会重复新建 */
subscriptionRoutes.post('/subscriptions/suggestions/accept', async c => {
  const { key, autoRenew } = z.object({ key: sourceKeySchema, autoRenew: z.boolean() }).parse(await c.req.json());
  const db = c.env.DB, today = shanghaiToday(), now = new Date().toISOString();
  const item = (await subscriptionSuggestions(db, today)).find(suggestion => suggestion.key === key);
  if (!item) throw new ApiError(409, 'SUGGESTION_GONE', '这条建议已经处理过或不再成立，请刷新后查看。');
  const row = await db.prepare(`INSERT INTO subscriptions(id,name,category,amount_cents,cycle,next_due_date,auto_renew,remind_days,note,source_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`)
    .bind(crypto.randomUUID(), item.name, item.category, item.amountCents, item.cycle, item.nextDueDate, Number(autoRenew), item.remindDays,
      `根据 ${item.count} 笔账单识别`, item.key, now, now).first<SubscriptionRow>();
  if (!row) throw new ApiError(409, 'SUGGESTION_GONE', '这条建议已经加入订阅。');
  return c.json({ data: toSubscription(row, today) }, 201);
});
/* 不是订阅：记住这条识别结果，之后不再推荐 */
subscriptionRoutes.post('/subscriptions/suggestions/dismiss', async c => {
  const { key } = z.object({ key: sourceKeySchema }).parse(await c.req.json());
  await c.env.DB.prepare('INSERT INTO subscription_dismissals(key,dismissed_at) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind(key, new Date().toISOString()).run();
  return c.json({ data: { dismissed: true } });
});
subscriptionRoutes.get('/subscriptions/:id', async c => {
  const id = itemId.parse(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(id).first<SubscriptionRow>();
  if (!row) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', '这项订阅不存在。');
  return c.json({ data: toSubscription(row, shanghaiToday()) });
});
subscriptionRoutes.post('/subscriptions', async c => {
  const { id, ...input } = z.object({ id: itemId }).passthrough().parse(await c.req.json());
  const value = normalizedInput(inputSchema.parse(input)), now = new Date().toISOString();
  const hash = await digest(JSON.stringify(value));
  const row = await c.env.DB.prepare(`INSERT INTO subscriptions(id,name,category,amount_cents,cycle,next_due_date,end_date,auto_renew,remind_days,note,url,created_at,updated_at,create_payload_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *`)
    .bind(id, value.name, value.category, value.amountCents, value.cycle, value.nextDueDate, value.endDate, Number(value.autoRenew), value.remindDays, value.note, value.url, now, now, hash)
    .first<SubscriptionRow>();
  if (row) return c.json({ data: toSubscription(row, shanghaiToday()) }, 201);
  const existing = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(id).first<SubscriptionRow>();
  if (!existing || existing.create_payload_hash !== hash) throw new ApiError(409, 'SUBSCRIPTION_CREATE_CONFLICT', '这次添加请求已被使用，请刷新后核对清单。');
  return c.json({ data: toSubscription(existing, shanghaiToday()) });
});
subscriptionRoutes.put('/subscriptions/:id', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version, ...input } = z.object({ version: versionSchema.shape.version }).passthrough().parse(await c.req.json());
  const value = normalizedInput(inputSchema.parse(input));
  const row = await c.env.DB.prepare(`UPDATE subscriptions SET name=?,category=?,amount_cents=?,cycle=?,next_due_date=?,end_date=?,auto_renew=?,remind_days=?,note=?,url=?,
    updated_at=?,version=version+1 WHERE id=? AND version=? AND version<9007199254740991 AND ended_at IS NULL RETURNING *`)
    .bind(value.name, value.category, value.amountCents, value.cycle, value.nextDueDate, value.endDate, Number(value.autoRenew), value.remindDays, value.note, value.url,
      new Date().toISOString(), id, version).first<SubscriptionRow>();
  return c.json({ data: await changed(c.env.DB, id, row) });
});
/* 本期已付：把当前这一期往后推一个周期。自动续期的项目从今天起的下一期算起，手动续期的从保存的扣费日算起；推到到期日及以后就变成不再续费。 */
subscriptionRoutes.post('/subscriptions/:id/renew', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version } = versionSchema.parse(await c.req.json());
  const db = c.env.DB, today = shanghaiToday();
  const current = await db.prepare('SELECT * FROM subscriptions WHERE id=? AND version=? AND ended_at IS NULL').bind(id, version).first<SubscriptionRow>();
  if (!current) return c.json({ data: await changed(db, id, null) });
  const item = toSubscription(current, today);
  if (item.state === 'ending' || item.state === 'finished') throw new ApiError(409, 'SUBSCRIPTION_NOT_RENEWING', '这项订阅已不再续费，没有要付的下一期。');
  const next = addCycles(item.dueDate, item.cycle, 1);
  if (next.slice(0, 4) > '2199') throw new ApiError(422, 'VALIDATION_ERROR', '续费后的扣费日超出允许范围。');
  const row = await db.prepare(`UPDATE subscriptions SET next_due_date=?,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND ended_at IS NULL RETURNING *`)
    .bind(next, new Date().toISOString(), id, version).first<SubscriptionRow>();
  return c.json({ data: await changed(db, id, row) });
});
/* 不再续费：把到期日设为下次扣费日，已付的这一期照常用到那天，之后不再扣费也不再提醒续费 */
subscriptionRoutes.post('/subscriptions/:id/end', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version } = versionSchema.parse(await c.req.json());
  const db = c.env.DB, today = shanghaiToday();
  const current = await db.prepare('SELECT * FROM subscriptions WHERE id=? AND version=? AND ended_at IS NULL').bind(id, version).first<SubscriptionRow>();
  if (!current) return c.json({ data: await changed(db, id, null) });
  const item = toSubscription(current, today);
  if (!isActive(item)) throw new ApiError(409, 'SUBSCRIPTION_NOT_RENEWING', '这项订阅已经到期。');
  const row = await db.prepare(`UPDATE subscriptions SET end_date=?,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND ended_at IS NULL RETURNING *`)
    .bind(item.dueDate, new Date().toISOString(), id, version).first<SubscriptionRow>();
  return c.json({ data: await changed(db, id, row) });
});
/* 恢复续费：清除到期日（以及旧版本的手动结束），按原周期继续 */
subscriptionRoutes.post('/subscriptions/:id/restore', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version } = versionSchema.parse(await c.req.json());
  const row = await c.env.DB.prepare(`UPDATE subscriptions SET end_date=NULL,ended_at=NULL,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND (end_date IS NOT NULL OR ended_at IS NOT NULL) RETURNING *`)
    .bind(new Date().toISOString(), id, version).first<SubscriptionRow>();
  return c.json({ data: await changed(c.env.DB, id, row) });
});
