import { z } from 'zod';
import type { DailyTotals, RefundAdjustment, Summary, Transaction, TransactionPage } from '../../shared/contracts';
import { TRANSACTION_KINDS, getTransactionCashflowKind } from '../../shared/contracts';
import { ApiError } from '../errors';
import { currentMonth, elapsedMonthDays, monthBounds, normalizeDate, parseInput, textId } from './domain';
import type { TransactionRow } from './repository';
import { effectiveExpenseCents, matchRefunds, projectTransaction, type RefundMatchRow } from './refunds';
import { listTags, loadTagOverrides } from './tags';
import type { TagOverride } from '../../shared/contracts';
import { matchTag } from '../../shared/tags';

const pageSchema = z.object({
  month: z.string().optional(), date: z.string().optional(),
  search: z.string().trim().max(200).optional(),
  kind: z.enum(TRANSACTION_KINDS).optional(),
  status: z.enum(['confirmed', 'pending']).optional(),
  deleted: z.enum(['true', 'false']).optional().default('false'),
  categoryId: textId.optional(), spendCategory: textId.optional(), accountId: textId.optional(), tagId: textId.optional(),
  page: z.string().regex(/^[1-9]\d{0,4}$/).transform(Number).optional().default(1),
  pageSize: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).optional().default(30),
  sort: z.enum(['newest', 'oldest', 'largest', 'smallest']).optional().default('newest'),
});
const orders = {
  newest: 'occurred_at DESC, id DESC', oldest: 'occurred_at ASC, id ASC',
  largest: 'amount_cents DESC, occurred_at DESC, id DESC', smallest: 'amount_cents ASC, occurred_at DESC, id DESC',
};

export async function listTransactions(db: D1Database, query: Record<string, string>): Promise<TransactionPage> {
  const options = parseInput(pageSchema, query);
  const conditions: string[] = [options.deleted === 'true' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const bindings: (string | number)[] = [];
  if (options.month) {
    const bounds = monthBounds(options.month);
    conditions.push('occurred_at >= ? AND occurred_at < ?');
    bindings.push(bounds.start, bounds.end);
  }
  if (options.date) {
    const start = normalizeDate(`${options.date}T00:00:00+08:00`);
    const end = new Date(new Date(start).valueOf() + 86400000).toISOString();
    conditions.push('occurred_at >= ? AND occurred_at < ?');
    bindings.push(start, end);
  }
  if (options.kind === 'income' || options.kind === 'expense') {
    conditions.push("(kind = ? OR (kind='transfer' AND transfer_direction = ?))");
    bindings.push(options.kind, options.kind === 'income' ? 'inflow' : 'outflow');
  } else if (options.kind) { conditions.push('kind = ?'); bindings.push(options.kind); }
  if (options.status) { conditions.push('review_status = ?'); bindings.push(options.status); }
  if (options.accountId) { conditions.push('account_id = ?'); bindings.push(options.accountId); }
  if (options.categoryId === 'uncategorized') conditions.push(options.kind === 'transfer' || options.kind === 'refund' ? 'category_id IS NULL' : "category_id IS NULL AND kind IN ('expense','income')");
  else if (options.categoryId) { conditions.push('category_id = ?'); bindings.push(options.categoryId); }
  if (options.spendCategory) {
    conditions.push(confirmed, "(kind='expense' OR (kind='transfer' AND transfer_direction='outflow'))");
    if (options.spendCategory === 'transfer') conditions.push("kind='transfer' AND category_id IS NULL");
    else if (options.spendCategory === 'uncategorized') conditions.push("kind='expense' AND category_id IS NULL");
    else { conditions.push('category_id = ?'); bindings.push(options.spendCategory); }
  }
  if (options.search) {
    const pattern = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(description LIKE ? ESCAPE '\\' OR counterparty LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern, pattern);
  }
  const where = conditions.join(' AND ');
  const pageSize = options.pageSize;
  // Filtering stays in SQL. Matching uses the complete confirmed ledger in the
  // same snapshot, so a search, category filter or page cannot hide a refund.
  const results = await db.batch([
    db.prepare(refundRowsSql),
    db.prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY ${orders[options.sort]}`).bind(...bindings),
  ]);
  const adjustments = matchRefunds(results[0].results as unknown as RefundMatchRow[]);
  let rows = results[1].results as unknown as TransactionRow[];
  if (options.spendCategory) rows = rows.filter(row => effectiveExpenseCents(row, adjustments) > 0);
  const overrides = await loadTagOverrides(db);
  if (options.tagId) {
    // 二级标签由规则实时推导，无法下推到 SQL；分类筛选已在 SQL 里缩小范围，这里再按同一个匹配器过滤。
    const { tags, rules } = await listTags(db);
    // tagId=none 表示该分类下未命中任何二级标签的账单（总览里的「其他」）
    const wanted = options.tagId === 'none' ? null : options.tagId;
    rows = rows.filter(row => (matchTag(tagInput(row, overrides), tags, rules)?.id ?? null) === wanted);
  }
  const { count: _, ...totals } = aggregateAmounts(rows, adjustments);
  const page: TransactionPage = {
    items: rows.slice((options.page - 1) * pageSize, options.page * pageSize).map(row => withTagOverride(projectTransaction(row, adjustments), overrides)),
    total: rows.length, page: options.page, pageSize, summary: totals, daily: aggregateDaily(rows, adjustments),
    breakdown: await expenseBreakdown(db, rows, adjustments, overrides),
  };
  checkSafeNumbers(page);
  return page;
}

const tagInput = (row: TransactionRow, overrides: Map<string, TagOverride>) =>
  ({ categoryId: row.category_id, description: row.description, counterparty: row.counterparty, tagOverride: overrides.get(row.id) });
const withTagOverride = (transaction: Transaction, overrides: Map<string, TagOverride>): Transaction => {
  const tagOverride = overrides.get(transaction.id);
  return tagOverride ? { ...transaction, tagOverride } : transaction;
};
/** 实际支出按「分类 × 二级标签」细分；口径与月汇总一致（已确认、扣除退款、未分类转出单列为「转出」） */
async function expenseBreakdown(db: D1Database, rows: readonly TransactionRow[], adjustments: Map<string, RefundAdjustment>,
  overrides: Map<string, TagOverride>): Promise<NonNullable<TransactionPage['breakdown']>> {
  const expenses = rows.filter(row => isConfirmed(row) && getTransactionCashflowKind({ kind: row.kind, transferDirection: row.transfer_direction }) === 'expense');
  if (!expenses.length) return [];
  const [{ tags, rules }, categories] = await Promise.all([listTags(db), db.prepare('SELECT id,name FROM categories').all<{ id: string; name: string }>()]);
  const names = new Map(categories.results.map(row => [row.id, row.name]));
  const groups = new Map<string, NonNullable<TransactionPage['breakdown']>[number]>();
  for (const row of expenses) {
    const amountCents = effectiveExpenseCents(row, adjustments);
    if (!amountCents) continue;
    const transfer = row.kind === 'transfer' && row.category_id === null;
    const categoryId = transfer ? 'transfer' : row.category_id;
    const tag = transfer ? null : matchTag(tagInput(row, overrides), tags, rules);
    const key = `${categoryId ?? ''}\u0000${tag?.id ?? ''}`;
    const group = groups.get(key) ?? { categoryId, categoryName: transfer ? '转出' : names.get(row.category_id ?? '') ?? '未分类',
      tagId: tag?.id ?? null, tagName: tag?.name ?? null, amountCents: 0, count: 0 };
    group.amountCents += amountCents; group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.amountCents - a.amountCents);
}
const confirmed = "deleted_at IS NULL AND review_status = 'confirmed'";
const refundRowsSql = `SELECT id,account_id,currency,kind,occurred_at,amount_cents,description,counterparty,deleted_at,review_status,transfer_direction
  FROM transactions WHERE ${confirmed} AND (kind IN ('expense','refund') OR (kind='transfer' AND transfer_direction='outflow'))`;

/** Resolve the current refund relation in one database snapshot, across months and pages. */
export async function getRefundExpense(db: D1Database, refundId: string): Promise<Transaction> {
  const [source, ledger, expenses] = await db.batch([
    db.prepare('SELECT kind FROM transactions WHERE id=?').bind(refundId),
    db.prepare(refundRowsSql),
    db.prepare(`SELECT * FROM transactions WHERE ${confirmed} AND (kind='expense' OR (kind='transfer' AND transfer_direction='outflow'))`),
  ]);
  if (!source.results.length) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '账单不存在。');
  if ((source.results[0] as { kind: string }).kind !== 'refund') throw new ApiError(422, 'NOT_A_REFUND', '只有退款记录可以查看对应支出。');
  const adjustments = matchRefunds(ledger.results as unknown as RefundMatchRow[]);
  const expenseId = adjustments.get(refundId)?.refundExpenseId;
  const expense = (expenses.results as unknown as TransactionRow[]).find(row => row.id === expenseId);
  if (!expense) throw new ApiError(404, 'REFUND_LINK_UNAVAILABLE', '退款关联已变化，暂时无法找到对应支出，请刷新账单后核对。');
  return withTagOverride(projectTransaction(expense, adjustments), await loadTagOverrides(db));
}
const isConfirmed = (row: TransactionRow) => row.deleted_at === null && row.review_status === 'confirmed';
type AmountTotals = TransactionPage['summary'] & { count: number };
function aggregateAmounts(rows: readonly TransactionRow[], adjustments: Map<string, RefundAdjustment>): AmountTotals {
  const totals = { expenseCents: 0, incomeCents: 0, refundCents: 0, transferCents: 0, grossExpenseCents: 0,
    matchedRefundCents: 0, unmatchedRefundCents: 0, transferInCents: 0, transferOutCents: 0, unknownTransferCents: 0,
    transferInCount: 0, transferOutCount: 0, unknownTransferCount: 0, expenseCount: 0, incomeCount: 0, refundCount: 0, transferCount: 0, count: 0 };
  for (const row of rows) {
    if (!isConfirmed(row)) continue;
    totals.count++;
    const flow = getTransactionCashflowKind({ kind: row.kind, transferDirection: row.transfer_direction });
    if (row.kind === 'transfer') {
      totals.transferCents += row.amount_cents; totals.transferCount++;
      const direction = row.transfer_direction === 'inflow' ? 'transferIn' : row.transfer_direction === 'outflow' ? 'transferOut' : 'unknownTransfer';
      totals[`${direction}Cents`] += row.amount_cents; totals[`${direction}Count`]++;
      if (flow === 'transfer') continue;
    }
    if (flow === 'expense') {
      const net = effectiveExpenseCents(row, adjustments);
      totals.grossExpenseCents += row.amount_cents;
      totals.expenseCents += net;
      totals.matchedRefundCents += row.amount_cents - net;
      if (net > 0) totals.expenseCount++;
    } else {
      totals[`${flow}Cents`] += row.amount_cents;
      totals[`${flow}Count`]++;
      if (row.kind === 'refund' && !adjustments.has(row.id)) totals.unmatchedRefundCents += row.amount_cents;
    }
  }
  return { ...totals, netExpenseCents: totals.grossExpenseCents - totals.refundCents,
    netIncomeCents: totals.incomeCents - totals.grossExpenseCents + totals.refundCents };
}
function aggregateDaily(rows: readonly TransactionRow[], adjustments: Map<string, RefundAdjustment>): DailyTotals[] {
  const groups = new Map<string, TransactionRow[]>();
  for (const row of rows) {
    if (!isConfirmed(row)) continue;
    const date = new Date(Date.parse(row.occurred_at) + 8 * 3600000).toISOString().slice(0, 10);
    const group = groups.get(date) ?? [];
    group.push(row); groups.set(date, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([date, group]) => {
    const { expenseCents, incomeCents, refundCents } = aggregateAmounts(group, adjustments);
    return { date, expenseCents, incomeCents, refundCents, fixedExpenseCents: group.reduce((sum, row) =>
      sum + (row.kind === 'expense' && row.is_fixed ? effectiveExpenseCents(row, adjustments) : 0), 0) };
  });
}

// SQLite stores 64-bit integers; never silently round a long-lived ledger's totals.
function checkSafeNumbers(value: unknown): void {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new ApiError(500, 'AMOUNT_OVERFLOW', '累计金额超出精确计算范围');
  if (value && typeof value === 'object') Object.values(value).forEach(checkSafeNumbers);
}

export async function getSummary(db: D1Database, month = currentMonth(), now = new Date()): Promise<Summary> {
  const bounds = monthBounds(month);
  const results = await db.batch([
    db.prepare(refundRowsSql),
    db.prepare('SELECT * FROM transactions WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at,id')
      .bind(bounds.previousStart, bounds.end),
    db.prepare('SELECT id,name FROM categories'),
  ]);
  const adjustments = matchRefunds(results[0].results as unknown as RefundMatchRow[]);
  const rows = results[1].results as unknown as TransactionRow[];
  const current = rows.filter(row => row.occurred_at >= bounds.start);
  const totals = aggregateAmounts(current, adjustments);
  const averageDays = elapsedMonthDays(month, now);
  const samePeriod = month === currentMonth(now);
  const dayMs = 86400000;
  const previousMonthDays = (Date.parse(bounds.start) - Date.parse(bounds.previousStart)) / dayMs;
  const previousDays = samePeriod ? Math.min(averageDays, previousMonthDays) : previousMonthDays;
  const previousEnd = new Date(Date.parse(bounds.previousStart) + previousDays * dayMs).toISOString();
  const currentDays = samePeriod ? averageDays : (Date.parse(bounds.end) - Date.parse(bounds.start)) / dayMs;
  const currentEnd = new Date(Date.parse(bounds.start) + currentDays * dayMs).toISOString();
  const previous = aggregateAmounts(rows.filter(row => row.occurred_at < previousEnd), adjustments);
  const currentComparison = samePeriod ? aggregateAmounts(current.filter(row => row.occurred_at < currentEnd), adjustments) : totals;
  const days = new Map(aggregateDaily(current, adjustments).map(day => [day.date, day]));
  const daily: Summary['daily'] = [];
  for (let time = new Date(bounds.start).valueOf(), end = new Date(bounds.end).valueOf(); time < end; time += 86400000) {
    const date = new Date(time + 8 * 3600000).toISOString().slice(0, 10);
    daily.push(days.get(date) ?? { date, expenseCents: 0, incomeCents: 0, refundCents: 0, fixedExpenseCents: 0 });
  }
  const dailyFixedExpenseCents = daily.reduce((sum, day) => sum + day.fixedExpenseCents, 0);
  const names = new Map((results[2].results as { id: string; name: string }[]).map(row => [row.id, row.name]));
  const [{ tags, rules: tagRules }, overrides] = await Promise.all([listTags(db), loadTagOverrides(db)]);
  const categories = new Map<string, Summary['categories'][number] & { kind: 'expense' | 'income'; tagTotals: Map<string, NonNullable<Summary['categories'][number]['tags']>[number]> }>();
  for (const row of current) {
    const flow = getTransactionCashflowKind({ kind: row.kind, transferDirection: row.transfer_direction });
    if (!isConfirmed(row) || (flow !== 'expense' && flow !== 'income')) continue;
    const amountCents = flow === 'expense' ? effectiveExpenseCents(row, adjustments) : row.amount_cents;
    if (!amountCents) continue;
    const isUncategorizedTransfer = row.kind === 'transfer' && row.category_id === null;
    const bucketId = isUncategorizedTransfer ? 'transfer' : row.category_id;
    const bucketName = isUncategorizedTransfer ? (flow === 'expense' ? '转出' : '转入') : (names.get(row.category_id ?? '') ?? '未分类');
    const key = JSON.stringify([flow, bucketId]);
    const category = categories.get(key) ?? { kind: flow, categoryId: bucketId,
      name: bucketName, amountCents: 0, count: 0, tagTotals: new Map() };
    category.amountCents += amountCents; category.count++;
    const tag = matchTag(tagInput(row, overrides), tags, tagRules);
    if (tag) {
      const total = category.tagTotals.get(tag.id) ?? { tagId: tag.id, name: tag.name, amountCents: 0, count: 0 };
      total.amountCents += amountCents; total.count++;
      category.tagTotals.set(tag.id, total);
    }
    categories.set(key, category);
  }
  const withTags = ({ kind: _, tagTotals, ...category }: (typeof categories extends Map<string, infer V> ? V : never)): Summary['categories'][number] =>
    tagTotals.size ? { ...category, tags: [...tagTotals.values()].sort((a, b) => b.amountCents - a.amountCents) } : category;
  const sortedCategories = [...categories.values()].sort((a, b) => b.amountCents - a.amountCents ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.categoryId ?? '') < (b.categoryId ?? '') ? -1 : (a.categoryId ?? '') > (b.categoryId ?? '') ? 1 : 0));
  const summary: Summary = {
    month, expenseCents: totals.expenseCents, incomeCents: totals.incomeCents, refundCents: totals.refundCents,
    transferCents: totals.transferCents, count: totals.count, grossExpenseCents: totals.grossExpenseCents,
    matchedRefundCents: totals.matchedRefundCents, unmatchedRefundCents: totals.unmatchedRefundCents,
    transferInCents: totals.transferInCents, transferOutCents: totals.transferOutCents, unknownTransferCents: totals.unknownTransferCents,
    transferInCount: totals.transferInCount, transferOutCount: totals.transferOutCount, unknownTransferCount: totals.unknownTransferCount,
    netExpenseCents: totals.netExpenseCents, netIncomeCents: totals.netIncomeCents,
    averageDays, dailyAverageExpenseCents: averageDays ? Math.round((totals.expenseCents - dailyFixedExpenseCents) / averageDays) : null,
    pendingCount: current.filter(row => row.deleted_at === null && row.review_status === 'pending').length,
    uncategorizedCount: current.filter(row => isConfirmed(row) && row.category_id === null && (row.kind === 'expense' || row.kind === 'income')).length,
    previous: {
      expenseCents: previous.expenseCents, incomeCents: previous.incomeCents, refundCents: previous.refundCents,
      month: bounds.previousMonth, period: samePeriod ? 'same-period' : 'full-month',
      startDate: `${bounds.previousMonth}-01`, endDate: `${bounds.previousMonth}-${String(previousDays).padStart(2, '0')}`,
      currentEndDate: `${month}-${String(currentDays).padStart(2, '0')}`, currentExpenseCents: currentComparison.expenseCents,
      netIncomeCents: previous.netIncomeCents, currentIncomeCents: currentComparison.incomeCents, currentNetIncomeCents: currentComparison.netIncomeCents,
      recordCount: previous.count, currentRecordCount: currentComparison.count,
      comparable: averageDays > 0 && previous.count > 0 && currentComparison.count > 0,
    },
    daily,
    categories: sortedCategories.filter(category => category.kind === 'expense').map(withTags),
    incomeCategories: sortedCategories.filter(category => category.kind === 'income').map(withTags),
    fixedExpenses: current.filter(row => isConfirmed(row) && row.kind === 'expense' && row.is_fixed && effectiveExpenseCents(row, adjustments) > 0)
      .map(row => withTagOverride(projectTransaction(row, adjustments), overrides)),
  };
  checkSafeNumbers(summary);
  return summary;
}
