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

function findUniqueSubsetSum(items: readonly RefundMatchRow[], target: number): RefundMatchRow[] | null {
  if (target <= 0 || !items.length || items.length > 15) return null;
  let found: RefundMatchRow[] | null = null;
  const current: RefundMatchRow[] = [];
  function dfs(index: number, sum: number): boolean {
    if (sum === target) {
      if (found !== null) return true; // more than 1 subset -> ambiguous
      found = [...current];
      return false;
    }
    if (index >= items.length || sum > target) return false;
    current.push(items[index]);
    if (dfs(index + 1, sum + items[index].amount_cents)) return true;
    current.pop();
    return dfs(index + 1, sum);
  }
  const ambiguous = dfs(0, 0);
  return ambiguous ? null : found;
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

  // Pass 2: For same-merchant multi-order split refunds (e.g. Taobao sub-order refunds),
  // match a unique subset of remaining refunds whose sum equals a candidate expense's remaining balance.
  if (unassigned.length > 0) {
    const claimed = new Set<string>();
    const candidateMap = new Map<string, ExpenseCandidate>();
    for (const u of unassigned) {
      for (const c of u.candidates) candidateMap.set(c.row.id, c);
    }
    const allCandidates = [...candidateMap.values()].sort((a, b) => a.time - b.time);
    const remainingOf = (expenseRow: RefundMatchRow) => {
      const group = proposed.get(expenseRow.id);
      const used = group ? group.refunds.reduce((s, r) => s + r.amount_cents, 0) : 0;
      return expenseRow.amount_cents - used;
    };

    let progress = true;
    while (progress) {
      progress = false;
      for (const cand of allCandidates) {
        const rem = remainingOf(cand.row);
        if (rem <= 0) continue;
        // Skip if another candidate expense has the exact same remaining balance
        if (allCandidates.some(other => other.row.id !== cand.row.id && remainingOf(other.row) === rem && sameMerchant(other.merchants, cand.merchants))) {
          continue;
        }
        const pool = unassigned
          .filter(u => !claimed.has(u.refund.id) && u.refund.amount_cents <= rem && u.candidates.some(c => c.row.id === cand.row.id))
          .map(u => u.refund);
        const subset = findUniqueSubsetSum(pool, rem);
        if (subset && subset.length > 0) {
          const group = proposed.get(cand.row.id) ?? { expense: cand.row, refunds: [] };
          for (const r of subset) {
            group.refunds.push(r);
            claimed.add(r.id);
          }
          proposed.set(cand.row.id, group);
          progress = true;
        }
      }
    }
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
