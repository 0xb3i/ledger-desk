import { Hono } from 'hono';
import { z } from 'zod';
import type { MonthlyBudget } from '../shared/contracts';
import type { ApiEnv } from './types';
import { ApiError } from './errors';
import { parseAmount } from './ledger/domain';

/* 月度总预算：一个金额适用于每个月；null 表示未设置。修改需提交当前版本，过期返回 409。 */

export const budgetInputSchema = z.object({
  amount: z.string().max(20).nullable(),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export const backupBudgetSchema = z.object({ amountCents: z.number().int().min(1).max(999_999_999_999) }).nullable();

type BudgetRow = { amount_cents: number | null; version: number };
const toBudget = (row: BudgetRow): MonthlyBudget => ({ amountCents: row.amount_cents === null ? null : Number(row.amount_cents), version: Number(row.version) });

export async function getBudget(db: D1Database): Promise<MonthlyBudget> {
  return toBudget((await db.prepare('SELECT amount_cents,version FROM monthly_budget WHERE id=1').first<BudgetRow>())!);
}

export async function updateBudget(db: D1Database, input: z.infer<typeof budgetInputSchema>): Promise<MonthlyBudget> {
  const cents = input.amount === null || !input.amount.trim() ? null : parseAmount(input.amount);
  const row = await db.prepare('UPDATE monthly_budget SET amount_cents=?,version=version+1,updated_at=? WHERE id=1 AND version=? RETURNING amount_cents,version')
    .bind(cents, new Date().toISOString(), input.version).first<BudgetRow>();
  if (!row) throw new ApiError(409, 'BUDGET_VERSION_CONFLICT', '预算已在别处修改，请刷新后重新保存。');
  return toBudget(row);
}

export const budgetRoutes = new Hono<ApiEnv>();
budgetRoutes.get('/budget', async c => c.json({ data: await getBudget(c.env.DB) }));
budgetRoutes.put('/budget', async c => c.json({ data: await updateBudget(c.env.DB, budgetInputSchema.parse(await c.req.json())) }));
