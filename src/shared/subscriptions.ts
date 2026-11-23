/* 订阅：周期换算与到期推算。前后端共用，日期一律是上海时区的 YYYY-MM-DD 字符串。 */

export const SUBSCRIPTION_CYCLES = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly'] as const;
export type SubscriptionCycle = typeof SUBSCRIPTION_CYCLES[number];
export const CYCLE_LABELS: Record<SubscriptionCycle, string> = {
  weekly: '每周', monthly: '每月', quarterly: '每季度', semiannual: '每半年', yearly: '每年',
};
/** 每个周期跨越的月数；按周的周期单独按 7 天推算 */
const CYCLE_MONTHS: Record<Exclude<SubscriptionCycle, 'weekly'>, number> = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };

export const SUBSCRIPTION_CATEGORIES = ['housing', 'software', 'membership', 'utility', 'insurance', 'other'] as const;
export type SubscriptionCategory = typeof SUBSCRIPTION_CATEGORIES[number];
export const SUBSCRIPTION_CATEGORY_LABELS: Record<SubscriptionCategory, string> = {
  housing: '居住', software: '软件订阅', membership: '会员服务', utility: '水电通讯', insurance: '保险', other: '其他',
};

export const REMIND_DAY_OPTIONS = [0, 1, 3, 7, 15, 30] as const;

const DAY = 86_400_000;
const toUtc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const fromUtc = (time: number) => new Date(time).toISOString().slice(0, 10);

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 2199 && fromUtc(toUtc(value)) === value;
}
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY);
}
export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY);
}
/** 从锚定日起第 count 期的日期。按月的周期保留锚定日的「几号」，遇到小月取月末，不会逐期漂移。 */
export function addCycles(anchor: string, cycle: SubscriptionCycle, count: number): string {
  if (cycle === 'weekly') return addDays(anchor, count * 7);
  const year = Number(anchor.slice(0, 4)), month = Number(anchor.slice(5, 7)) - 1 + CYCLE_MONTHS[cycle] * count, day = Number(anchor.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(year, month, Math.min(day, lastDay)));
}
/** 不早于 from 的第一期（含 from 当天）；锚定日本身就不早于 from 时直接返回 */
export function nextOccurrence(anchor: string, cycle: SubscriptionCycle, from: string): string {
  if (anchor >= from) return anchor;
  const gap = cycle === 'weekly' ? Math.floor(daysBetween(anchor, from) / 7)
    : Math.floor(((Number(from.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(from.slice(5, 7)) - Number(anchor.slice(5, 7))) / CYCLE_MONTHS[cycle]);
  let count = Math.max(0, gap - 1);
  while (addCycles(anchor, cycle, count) < from) count++;
  return addCycles(anchor, cycle, count);
}
/** 折算成每月金额（分），用于合计；按周按 52 周 / 12 个月折算 */
export function monthlyEquivalentCents(amountCents: number, cycle: SubscriptionCycle): number {
  return cycle === 'weekly' ? Math.round(amountCents * 52 / 12) : Math.round(amountCents / CYCLE_MONTHS[cycle]);
}

/** 一年的实际合计（分）：按每年发生的期数累加，不经过月额折算，避免出现零头 */
export function yearlyCents(amountCents: number, cycle: SubscriptionCycle): number {
  return amountCents * (cycle === 'weekly' ? 52 : 12 / CYCLE_MONTHS[cycle]);
}

/**
 * upcoming／soon／overdue：还会继续扣费（soon 表示进入提醒窗口）。
 * ending：已不再续费，最后一期已付，服务用到到期日为止；仍在进行中。
 * finished：过了到期日，归入「已到期」。ended：旧版本手动结束的项目，同样归入「已到期」。
 */
export type SubscriptionState = 'upcoming' | 'soon' | 'overdue' | 'ending' | 'finished' | 'ended';
export interface SubscriptionInput {
  name: string; category: SubscriptionCategory; amount: string; cycle: SubscriptionCycle;
  /** 下次扣费日 YYYY-MM-DD */
  nextDueDate: string;
  /** 到期日：用到这天为止，这天及以后不再扣费；null 表示一直续 */
  endDate?: string | null;
  autoRenew: boolean; remindDays: number; note: string;
}
export interface Subscription {
  id: string; name: string; category: SubscriptionCategory; amountCents: number; cycle: SubscriptionCycle;
  /** 保存的锚定日；自动续期的项目会从这一天按周期往后推 */
  nextDueDate: string; endDate: string | null; autoRenew: boolean; remindDays: number; note: string;
  /** 从固定支出账单导入时的来源标识 */
  sourceKey: string | null;
  createdAt: string; updatedAt: string; endedAt: string | null; version: number;
  /** 以下由服务端按今天推算。dueDate 是下次扣费日；不再续费（ending／finished）时是到期日。isFinal 表示这是到期前的最后一次扣费 */
  dueDate: string; daysLeft: number; state: SubscriptionState; monthlyCents: number; isFinal: boolean;
}
/** 备份里保存的原始字段 */
export type SubscriptionRecord = Omit<Subscription, 'dueDate' | 'daysLeft' | 'state' | 'monthlyCents' | 'isFinal'>;
export interface SubscriptionList {
  items: Subscription[]; today: string;
  counts: { active: number; ended: number };
  /** 进行中的项目按月折算合计、按年合计、本月剩余几天内还会发生的扣费 */
  monthlyCents: number; yearlyCents: number; remainingThisMonthCents: number;
  /** 进行中的项目按类别的月额构成，从高到低 */
  byCategory: { category: SubscriptionCategory; monthlyCents: number; count: number }[];
}
export interface SubscriptionReminders { items: Subscription[]; today: string }
/** 从账单里识别出的可能订阅：同一对象、同样金额、按固定周期重复出现（标记为固定支出的账单金额可以变化） */
export interface SubscriptionSuggestion {
  key: string; name: string; category: SubscriptionCategory; amountCents: number; cycle: SubscriptionCycle;
  nextDueDate: string; remindDays: number;
  /** 建议的扣款方式：房租等居住类默认手动付款，其余默认自动扣款 */
  autoRenew: boolean;
  /** 依据的账单笔数与最近一次扣费日 */
  count: number; lastPaidAt: string;
}
export interface SubscriptionSuggestionList { items: SubscriptionSuggestion[] }

type Stored = Pick<Subscription, 'amountCents' | 'cycle' | 'nextDueDate' | 'endDate' | 'autoRenew' | 'remindDays' | 'endedAt'>;
/** 下一次真正会发生的扣费日：到期日当天及以后的扣费不算；没有了返回 null */
function nextCharge(item: Stored, today: string): string | null {
  const date = item.autoRenew ? nextOccurrence(item.nextDueDate, item.cycle, today) : item.nextDueDate;
  return item.endDate !== null && date >= item.endDate ? null : date;
}
/** 推算下次扣费日（或到期日）、剩余天数和提醒状态 */
export function subscriptionSchedule(item: Stored, today: string): Pick<Subscription, 'dueDate' | 'daysLeft' | 'state' | 'monthlyCents' | 'isFinal'> {
  const charge = item.endedAt || (item.endDate !== null && today >= item.endDate) ? null : nextCharge(item, today);
  const dueDate = charge ?? item.endDate ?? item.nextDueDate;
  const daysLeft = daysBetween(today, dueDate);
  const state: SubscriptionState = item.endedAt ? 'ended' : item.endDate !== null && today >= item.endDate ? 'finished'
    : charge === null ? 'ending' : daysLeft < 0 ? 'overdue' : daysLeft <= item.remindDays ? 'soon' : 'upcoming';
  return { dueDate, daysLeft, state, monthlyCents: monthlyEquivalentCents(item.amountCents, item.cycle),
    isFinal: charge !== null && item.endDate !== null && addCycles(charge, item.cycle, 1) >= item.endDate };
}
export const isActive = (item: Pick<Subscription, 'state'>) => item.state !== 'ended' && item.state !== 'finished';
/** 需要在铃铛里提醒：只有手动付款的订阅才提醒（快到付款日、逾期，或快到期且不再续费）；自动扣款的只在订阅页列出 */
export const needsReminder = (item: Pick<Subscription, 'autoRenew' | 'state' | 'daysLeft' | 'remindDays'>) =>
  !item.autoRenew && (item.state === 'soon' || item.state === 'overdue' || (item.state === 'ending' && item.daysLeft <= item.remindDays));
/** today 到 until（含）之间这一项还要付的钱；手动续期的项目只算当前这一期，逾期未付的也算在内；到期日当天及以后不再扣费 */
export function chargesBetween(item: Stored, today: string, until: string): number {
  if (item.endedAt || (item.endDate !== null && today >= item.endDate)) return 0;
  const stops = (date: string) => date > until || (item.endDate !== null && date >= item.endDate);
  if (!item.autoRenew) return stops(item.nextDueDate) ? 0 : item.amountCents;
  let total = 0;
  for (let date = nextOccurrence(item.nextDueDate, item.cycle, today), n = 0; !stops(date) && n < 10; n++) {
    total += item.amountCents;
    date = nextOccurrence(item.nextDueDate, item.cycle, addDays(date, 1));
  }
  return total;
}
/** 日期描述：今天扣费 / 3 天后付款 / 逾期 2 天；手动付款的叫「付款」，不再续费的叫「到期」 */
export function dueLabel(item: Pick<Subscription, 'daysLeft' | 'state'> & { autoRenew?: boolean }): string {
  const word = item.state === 'ending' || item.state === 'finished' ? '到期' : item.autoRenew === false ? '付款' : '扣费';
  if (item.daysLeft === 0) return `今天${word}`;
  if (item.daysLeft === 1) return `明天${word}`;
  return item.daysLeft > 0 ? `${item.daysLeft} 天后${word}` : item.state === 'overdue' ? `逾期 ${-item.daysLeft} 天` : `已${word}`;
}
