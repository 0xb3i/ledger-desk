import { Hono } from 'hono';
import { z } from 'zod';
import { CATEGORY_ICON_OPTIONS, CATEGORY_COLOR_OPTIONS, defaultCategoryAppearance, type Category, type CategoryInput } from '../../shared/contracts';
import type { ApiEnv } from '../types';
import { ApiError, invalid } from '../errors';
import { versionSchema } from './domain';

export const normalizeCategoryName = (name: string): string => name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export const categoryNameKey = (name: string): string => normalizeCategoryName(name).toLowerCase();
export const categoryInputSchema = z.object({
  name: z.string().transform(normalizeCategoryName).pipe(z.string().min(1).max(60).refine(name => name !== '未分类' && name !== '全部分类', '请使用具体的类目名称。')),
  kind: z.enum(['expense', 'income', 'both']),
  icon: z.enum(CATEGORY_ICON_OPTIONS.map(option => option.value)),
  color: z.enum(CATEGORY_COLOR_OPTIONS.map(option => option.value)),
});
export const categorySchema = categoryInputSchema.extend({ id: z.string().min(1).max(100), version: versionSchema.shape.version });
export function mapCategory(value: unknown): Category {
  const row = value as Record<string, unknown>, defaults = defaultCategoryAppearance(String(row.id));
  return { id: String(row.id), name: String(row.name), kind: row.kind as Category['kind'],
    icon: (row.icon ?? defaults.icon) as Category['icon'], color: (row.color ?? defaults.color) as Category['color'], version: Number(row.version ?? 1) };
}
export function rethrowCategoryReferenceError(error: unknown): never {
  if (error instanceof Error && /transaction_category_kind_conflict/.test(error.message)) invalid('分类与交易类型不匹配，请重新选择分类。');
  throw error;
}
// Immutable migration seeds are eligible for replacement only in an unused new ledger.
export const builtinCategorySeeds: readonly Category[] = [
  ['food', '餐饮', 'expense'], ['shopping', '购物', 'expense'], ['transport', '交通', 'expense'],
  ['housing', '居住', 'expense'], ['health', '健康', 'expense'], ['leisure', '休闲', 'expense'],
  ['learning', '学习', 'expense'], ['salary', '工资', 'income'], ['other-income', '其他收入', 'income'], ['other', '其他', 'both'],
].map(([id, name, kind]) => ({ id, name, kind: kind as Category['kind'], ...defaultCategoryAppearance(id), version: 1 }));
export async function listCategories(db: D1Database): Promise<Category[]> {
  return (await db.prepare('SELECT * FROM categories ORDER BY rowid').all()).results.map(mapCategory);
}
function conflict(): never { throw new ApiError(409, 'CATEGORY_VERSION_CONFLICT', '类目或引用它的账单、规则已变化，请刷新后重新操作。'); }
function explainCategoryError(error: unknown): never {
  if (error instanceof Error && /categories_name_key|UNIQUE constraint failed: categories\.name_key/i.test(error.message)) {
    throw new ApiError(409, 'CATEGORY_EXISTS', '已有同名类目，请使用不同名称。');
  }
  if (error instanceof Error && /category_kind_reference_conflict/.test(error.message)) invalid('已有账单或规则使用此类目，不能改为不兼容的收支范围。');
  if (error instanceof Error && /constraint/i.test(error.message)) conflict();
  throw error;
}
export async function createCategory(db: D1Database, input: CategoryInput): Promise<Category> {
  const value = categoryInputSchema.parse(input);
  const id = crypto.randomUUID();
  try {
    const row = await db.prepare('INSERT INTO categories(id,name,kind,icon,color,name_key,version) VALUES(?,?,?,?,?,?,1) RETURNING *')
      .bind(id, value.name, value.kind, value.icon, value.color, categoryNameKey(value.name)).first();
    return mapCategory(row!);
  } catch (error) { explainCategoryError(error); }
}
export async function updateCategory(db: D1Database, id: string, input: CategoryInput, version: number): Promise<Category> {
  const value = categoryInputSchema.parse(input);
  const [generation, existing, references] = await db.batch([
    db.prepare('SELECT revision FROM classification_state WHERE id=1'),
    db.prepare('SELECT * FROM categories WHERE id=?').bind(id),
    db.prepare(`SELECT EXISTS(SELECT 1 FROM transactions WHERE category_id=?
      AND ?!='both' AND ?!=CASE WHEN kind='refund' THEN 'expense' WHEN kind='transfer' AND transfer_direction='inflow' THEN 'income' WHEN kind='transfer' AND transfer_direction='outflow' THEN 'expense' ELSE kind END)
      OR EXISTS(SELECT 1 FROM category_rules WHERE category_id=? AND ?!='both' AND kind!=?) AS incompatible`)
      .bind(id, value.kind, value.kind, id, value.kind, value.kind),
  ]);
  const current = existing.results[0] as { version: number } | undefined;
  if (!current) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '类目不存在。');
  if (current.version !== version) conflict();
  if ((references.results[0] as { incompatible: number }).incompatible) invalid('已有账单或规则使用此类目，不能改为不兼容的收支范围。');
  const revision = (generation.results[0] as { revision: number }).revision, guardId = `category:${crypto.randomUUID()}`;
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO restore_guards(id,valid) VALUES(?,CASE WHEN (SELECT revision FROM classification_state WHERE id=1)=? THEN 1 ELSE 0 END)`).bind(guardId, revision),
      db.prepare('UPDATE categories SET name=?,kind=?,icon=?,color=?,name_key=?,version=version+1 WHERE id=? AND version=? RETURNING *')
        .bind(value.name, value.kind, value.icon, value.color, categoryNameKey(value.name), id, version),
      db.prepare('DELETE FROM restore_guards WHERE id=?').bind(guardId),
    ]);
    if (!results[1].results.length) conflict();
    return mapCategory(results[1].results[0]);
  } catch (error) { explainCategoryError(error); }
}

export const categoryRoutes = new Hono<ApiEnv>();
categoryRoutes.get('/categories', async c => c.json({ data: { items: await listCategories(c.env.DB) } }));
categoryRoutes.post('/categories', async c => c.json({ data: await createCategory(c.env.DB, categoryInputSchema.parse(await c.req.json())) }, 201));
categoryRoutes.patch('/categories/:id', async c => {
  const { version, ...input } = categoryInputSchema.extend({ version: versionSchema.shape.version }).parse(await c.req.json());
  return c.json({ data: await updateCategory(c.env.DB, c.req.param('id'), input, version) });
});
