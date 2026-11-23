import type { RefundAdjustment, Transaction } from '../../shared/contracts';
import { toTransaction, type TransactionRow } from './repository';

const MATCH_WINDOW_MS = 90 * 86400000;
const genericLabels = new Set(['支付宝', '财付通', '微信', '微信支付', '美团', '美团app', '拼多多', '拼多多支付', '平台商户', '商户', '消费', '退款', '入账', '收款', '其他']);
export type RefundMatchRow = Pick<TransactionRow, 'id' | 'account_id' | 'currency' | 'kind' | 'occurred_at' | 'amount_cents' | 'description' | 'counterparty' | 'deleted_at' | 'review_status' | 'transfer_direction'>;
interface Merchant { text: string; truncated: boolean }
interface ExpenseCandidate { row: RefundMatchRow; merchants: Merchant[]; time: number }
function timeBoundary(bucket: ExpenseCandidate[], time: number, inclusive: boolean): number {
  let left = 0, right = bucket.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (bucket[middle].time < time || (inclusive && bucket[middle].time === time)) left = middle + 1;
    else right = middle;
  }
  return left;
}
function merchant(value: string, refund: boolean): Merchant | null {
  let text = value.normalize('NFKC').replace(/[－—–]/gu, '-').replace(/\s+/gu, ' ').trim().toLowerCase();
  const truncated = /\.{3,}$/.test(text);
  text = truncated ? text.replace(/\.{3,}$/, '').trim() : text.replace(/[。.]+$/, '').trim();
  if (refund && !truncated) text = text.replace(/(?:\s*[-:/]?\s*)(?:退款|退费|退回)(?:成功)?$/, '').trim();
  if (!text || text.split('-').every(part => genericLabels.has(part.trim()))) return null;
  return { text, truncated };
}
function merchants(row: RefundMatchRow): Merchant[] {
  return [row.description, row.counterparty].map(value => merchant(value, row.kind === 'refund')).filter((value): value is Merchant => value !== null);
}
function sameMerchant(left: Merchant[], right: Merchant[]): boolean {
  return left.some(a => right.some(b => (a.text === b.text && ((!a.truncated && !b.truncated) || a.text.length >= 12)) ||
    (a.truncated && a.text.length >= 12 && b.text.startsWith(a.text)) ||
    (b.truncated && b.text.length >= 12 && a.text.startsWith(b.text))));
}
const eligible = (row: RefundMatchRow) => row.deleted_at === null && row.review_status === 'confirmed';

// Track every refund that can participate in a full match, including alternatives
// for expenses with several valid subsets. Another expense cannot claim those refunds.
function splitRefundOptions(items: readonly RefundMatchRow[], target: number) {
  const possible = new Set<string>();
  let count = 0;
  if (items.length > 15) return { possible: new Set(items.map(item => item.id)), unique: false };
  const current: RefundMatchRow[] = [];
  function visit(index: number, sum: number): void {
    if (sum === target) {
      count++;
      for (const item of current) possible.add(item.id);
      return;
    }
    if (index === items.length || sum > target) return;
    current.push(items[index]);
    visit(index + 1, sum + items[index].amount_cents);
    current.pop();
    visit(index + 1, sum);
  }
  if (target > 0) visit(0, 0);
  return { possible, unique: count === 1 };
}

/** A read-only projection: ambiguous or excessive refunds never erase an expense. */
export function matchRefunds(rows: readonly RefundMatchRow[]): Map<string, RefundAdjustment> {
  const expenses = new Map<string, ExpenseCandidate[]>();
  for (const row of rows) {
    if (!eligible(row) || (row.kind !== 'expense' && !(row.kind === 'transfer' && row.transfer_direction === 'outflow'))) continue;
    const key = JSON.stringify([row.account_id, row.currency]);
    const bucket = expenses.get(key) ?? [];
    bucket.push({ row, merchants: merchants(row), time: Date.parse(row.occurred_at) });
    expenses.set(key, bucket);
  }
  for (const bucket of expenses.values()) bucket.sort((a, b) => a.time - b.time);
  const proposed = new Map<string, { expense: RefundMatchRow; refunds: RefundMatchRow[] }>();
  const unassigned: { refund: RefundMatchRow; candidates: ExpenseCandidate[] }[] = [];
  for (const refund of rows) {
    if (!eligible(refund) || refund.kind !== 'refund') continue;
    const time = Date.parse(refund.occurred_at), identity = merchants(refund);
    if (!identity.length) continue;
    const bucket = expenses.get(JSON.stringify([refund.account_id, refund.currency])) ?? [];
    const candidates = bucket.slice(timeBoundary(bucket, time - MATCH_WINDOW_MS, false), timeBoundary(bucket, time, true)).filter(expense =>
      expense.row.amount_cents >= refund.amount_cents &&
      sameMerchant(expense.merchants, identity));
    const exact = candidates.filter(candidate => candidate.row.amount_cents === refund.amount_cents);
    const preferred = exact.length ? exact : candidates;
    if (preferred.length === 1) {
      const expense = preferred[0].row;
      const group = proposed.get(expense.id) ?? { expense, refunds: [] };
      group.refunds.push(refund);
      proposed.set(expense.id, group);
    } else if (preferred.length > 1) {
      unassigned.push({ refund, candidates: preferred });
    }
  }

  const pools = new Map<string, { expense: RefundMatchRow; refunds: RefundMatchRow[] }>();
  for (const { refund, candidates } of unassigned) {
    for (const { row: expense } of candidates) {
      const pool = pools.get(expense.id) ?? { expense, refunds: [] };
      pool.refunds.push(refund);
      pools.set(expense.id, pool);
    }
  }
  const contenders = new Map<string, number>();
  const splits: { expense: RefundMatchRow; refunds: RefundMatchRow[] }[] = [];
  for (const { expense, refunds } of pools.values()) {
    const assigned = proposed.get(expense.id)?.refunds ?? [];
    const remaining = expense.amount_cents - assigned.reduce((sum, r) => sum + r.amount_cents, 0);
    const { possible, unique } = splitRefundOptions(refunds.filter(r => r.amount_cents <= remaining), remaining);
    for (const id of possible) contenders.set(id, (contenders.get(id) ?? 0) + 1);
    if (unique) splits.push({ expense, refunds: refunds.filter(r => possible.has(r.id)) });
  }
  for (const { expense, refunds } of splits) {
    if (refunds.some(r => contenders.get(r.id) !== 1)) continue;
    const group = proposed.get(expense.id) ?? { expense, refunds: [] };
    group.refunds.push(...refunds);
    proposed.set(expense.id, group);
  }
  const result = new Map<string, RefundAdjustment>();
  for (const { expense, refunds } of proposed.values()) {
    const refundedCents = refunds.reduce((sum, refund) => sum + refund.amount_cents, 0);
    if (!Number.isSafeInteger(refundedCents) || refundedCents > expense.amount_cents) continue;
    result.set(expense.id, { refundedCents, netExpenseCents: expense.amount_cents - refundedCents, refundExpenseId: null });
    for (const refund of refunds) result.set(refund.id, { refundedCents: refund.amount_cents, netExpenseCents: 0, refundExpenseId: expense.id });
  }
  return result;
}
export function effectiveExpenseCents(row: TransactionRow, adjustments: Map<string, RefundAdjustment>): number {
  return row.kind === 'expense' || (row.kind === 'transfer' && row.transfer_direction === 'outflow')
    ? adjustments.get(row.id)?.netExpenseCents ?? row.amount_cents : 0;
}
export function projectTransaction(row: TransactionRow, adjustments: Map<string, RefundAdjustment>): Transaction {
  const adjustment = adjustments.get(row.id);
  return { ...toTransaction(row), ...(adjustment ? { refundAdjustment: adjustment } : {}) };
}
