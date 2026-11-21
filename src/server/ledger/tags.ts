import { Hono } from 'hono';
import { z } from 'zod';
import { TAG_ICON_OPTIONS, type Tag, type TagList, type TagOverride, type TagRule } from '../../shared/contracts';
import type { ApiEnv } from '../types';
import { ApiError, invalid } from '../errors';
import { textId, versionSchema } from './domain';

const nameSchema = z.string().transform(value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim()).pipe(z.string().min(1).max(30));
const keywordSchema = z.string().trim().min(1).max(100);
const iconSchema = z.enum(TAG_ICON_OPTIONS.map(option => option.value) as [Tag['icon'], ...Tag['icon'][]]);
export const tagSchema = z.object({ id: textId, name: nameSchema, categoryId: textId, icon: iconSchema.optional().default('other'), position: z.number().int().min(0).max(1_000_000_000).optional().default(0), version: versionSchema.shape.version });
export const tagRuleSchema = z.object({ id: textId, tagId: textId, keyword: keywordSchema, matchType: z.enum(['contains', 'exact']), version: versionSchema.shape.version });

export interface TagRow { id: string; name: string; category_id: string; icon: string | null; position: number; version: number }
export interface TagRuleRow { id: string; tag_id: string; keyword: string; match_type: TagRule['matchType']; version: number }
export const toTag = (row: TagRow): Tag => ({ id: row.id, name: row.name, categoryId: row.category_id, icon: (TAG_ICON_OPTIONS.some(option => option.value === row.icon) ? row.icon : 'other') as Tag['icon'], position: Number(row.position ?? 0), version: row.version });
export const toTagRule = (row: TagRuleRow): TagRule => ({ id: row.id, tagId: row.tag_id, keyword: row.keyword, matchType: row.match_type, version: row.version });

export async function listTags(db: D1Database): Promise<TagList> {
  const [tags, rules] = await db.batch([
    db.prepare('SELECT * FROM tags ORDER BY category_id, position, id'),
    db.prepare('SELECT * FROM tag_rules ORDER BY tag_id, rowid'),
  ]);
  return { tags: (tags.results as unknown as TagRow[]).map(toTag), rules: (rules.results as unknown as TagRuleRow[]).map(toTagRule) };
}

const conflict = (): never => { throw new ApiError(409, 'TAG_VERSION_CONFLICT', '标签已发生变化，请刷新后重新操作。'); };
const notFound = (): never => { throw new ApiError(404, 'TAG_NOT_FOUND', '标签不存在。'); };
function explain(error: unknown): never {
  if (error instanceof Error && /UNIQUE constraint failed: tags/i.test(error.message)) throw new ApiError(409, 'TAG_EXISTS', '这个分类下已有同名标签。');
  if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) invalid('所属分类或标签不存在，请刷新后重试。');
  throw error;
}

export const tagRoutes = new Hono<ApiEnv>();
tagRoutes.get('/tags', async c => c.json({ data: await listTags(c.env.DB) }));
tagRoutes.post('/tags', async c => {
  const { name, categoryId, icon } = z.object({ name: nameSchema, categoryId: textId, icon: iconSchema.default('other') }).parse(await c.req.json());
  const row = await c.env.DB.prepare(`INSERT INTO tags(id,name,category_id,icon,position)
    VALUES(?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM tags WHERE category_id=?)) RETURNING *`)
    .bind(crypto.randomUUID(), name, categoryId, icon, categoryId).first<TagRow>().catch(explain);
  return c.json({ data: toTag(row!) }, 201);
});
tagRoutes.patch('/tags/:id', async c => {
  // 改名或换图标：未传的字段保持原值
  const { name, icon, version } = z.object({ name: nameSchema.optional(), icon: iconSchema.optional(), version: versionSchema.shape.version }).parse(await c.req.json());
  const row = await c.env.DB.prepare('UPDATE tags SET name=COALESCE(?,name),icon=COALESCE(?,icon),version=version+1 WHERE id=? AND version=? RETURNING *')
    .bind(name ?? null, icon ?? null, c.req.param('id'), version).first<TagRow>().catch(explain);
  if (row) return c.json({ data: toTag(row) });
  return (await c.env.DB.prepare('SELECT id FROM tags WHERE id=?').bind(c.req.param('id')).first()) ? conflict() : notFound();
});
/** 上移/下移：与同分类相邻标签交换顺序，两条更新在一个批次里提交 */
tagRoutes.post('/tags/:id/move', async c => {
  const { direction } = z.object({ direction: z.enum(['up', 'down']) }).parse(await c.req.json());
  const id = c.req.param('id');
  const tag = await c.env.DB.prepare('SELECT * FROM tags WHERE id=?').bind(id).first<TagRow>();
  if (!tag) notFound();
  const siblings = (await c.env.DB.prepare('SELECT * FROM tags WHERE category_id=? ORDER BY position, id').bind(tag!.category_id).all<TagRow>()).results;
  const index = siblings.findIndex(row => row.id === id), other = siblings[direction === 'up' ? index - 1 : index + 1];
  if (other) {
    // Renumber densely so equal legacy positions still swap deterministically.
    const order = siblings.map(row => row.id);
    [order[index], order[siblings.indexOf(other)]] = [other.id, id];
    await c.env.DB.batch(order.map((tagId, i) => c.env.DB.prepare('UPDATE tags SET position=? WHERE id=?').bind(i + 1, tagId)));
  }
  return c.json({ data: await listTags(c.env.DB) });
});
tagRoutes.delete('/tags/:id', async c => {
  const { version } = versionSchema.parse(await c.req.json());
  const row = await c.env.DB.prepare('DELETE FROM tags WHERE id=? AND version=? RETURNING id').bind(c.req.param('id'), version).first();
  if (row) return c.json({ data: { deleted: true } });
  return (await c.env.DB.prepare('SELECT id FROM tags WHERE id=?').bind(c.req.param('id')).first()) ? conflict() : notFound();
});

const ruleInput = z.object({ keyword: keywordSchema, matchType: z.enum(['contains', 'exact']).default('contains') });
tagRoutes.post('/tag-rules', async c => {
  const { tagId, keyword, matchType } = ruleInput.extend({ tagId: textId }).parse(await c.req.json());
  const row = await c.env.DB.prepare('INSERT INTO tag_rules(id,tag_id,keyword,match_type) VALUES(?,?,?,?) RETURNING *')
    .bind(crypto.randomUUID(), tagId, keyword, matchType).first<TagRuleRow>().catch(explain);
  return c.json({ data: toTagRule(row!) }, 201);
});
tagRoutes.patch('/tag-rules/:id', async c => {
  const { keyword, matchType, version } = ruleInput.extend({ version: versionSchema.shape.version }).parse(await c.req.json());
  const row = await c.env.DB.prepare('UPDATE tag_rules SET keyword=?,match_type=?,version=version+1 WHERE id=? AND version=? RETURNING *')
    .bind(keyword, matchType, c.req.param('id'), version).first<TagRuleRow>();
  if (row) return c.json({ data: toTagRule(row) });
  return (await c.env.DB.prepare('SELECT id FROM tag_rules WHERE id=?').bind(c.req.param('id')).first()) ? conflict() : notFound();
});
tagRoutes.delete('/tag-rules/:id', async c => {
  const { version } = versionSchema.parse(await c.req.json());
  const row = await c.env.DB.prepare('DELETE FROM tag_rules WHERE id=? AND version=? RETURNING id').bind(c.req.param('id'), version).first();
  if (row) return c.json({ data: { deleted: true } });
  return (await c.env.DB.prepare('SELECT id FROM tag_rules WHERE id=?').bind(c.req.param('id')).first()) ? conflict() : notFound();
});

/* 单笔账单手动指定二级标签 */
export interface TransactionTagRow { transaction_id: string; category_id: string; tag_id: string | null }
export async function loadTagOverrides(db: D1Database): Promise<Map<string, TagOverride>> {
  const rows = (await db.prepare('SELECT * FROM transaction_tags').all<TransactionTagRow>()).results;
  return new Map(rows.map(row => [row.transaction_id, mapTagOverride(row)]));
}
function mapTagOverride(row: TransactionTagRow): TagOverride {
  return { categoryId: row.category_id, tagId: row.tag_id };
}
export async function getTagOverride(db: D1Database, id: string): Promise<TagOverride | undefined> {
  const row = await db.prepare('SELECT * FROM transaction_tags WHERE transaction_id=?').bind(id).first<TransactionTagRow>();
  return row ? mapTagOverride(row) : undefined;
}
tagRoutes.put('/transactions/:id/tag', async c => {
  const { tagId } = z.object({ tagId: textId.nullable() }).parse(await c.req.json());
  const id = c.req.param('id');
  const transaction = await c.env.DB.prepare('SELECT category_id FROM transactions WHERE id=? AND deleted_at IS NULL').bind(id).first<{ category_id: string | null }>();
  if (!transaction) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '账单不存在。');
  if (!transaction.category_id) invalid('请先给这笔账单选择分类。');
  if (tagId !== null) {
    const tag = await c.env.DB.prepare('SELECT category_id FROM tags WHERE id=?').bind(tagId).first<{ category_id: string }>();
    if (!tag || tag.category_id !== transaction.category_id) invalid('这个二级标签不属于账单当前的分类。');
  }
  const row = await c.env.DB.prepare(`INSERT INTO transaction_tags(transaction_id,category_id,tag_id)
    SELECT id, category_id, ? FROM transactions WHERE id=? AND deleted_at IS NULL AND category_id=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM tags WHERE id=? AND category_id=transactions.category_id))
    ON CONFLICT(transaction_id) DO UPDATE SET category_id=excluded.category_id, tag_id=excluded.tag_id RETURNING *`)
    .bind(tagId, id, transaction.category_id, tagId, tagId).first<TransactionTagRow>();
  if (!row) throw new ApiError(409, 'TAG_VERSION_CONFLICT', '账单或标签已变化，请刷新后重试。');
  const tagOverride = mapTagOverride(row);
  return c.json({ data: { tagOverride } });
});
tagRoutes.delete('/transactions/:id/tag', async c => {
  const id = c.req.param('id');
  const [active] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id FROM transactions WHERE id=? AND deleted_at IS NULL').bind(id),
    c.env.DB.prepare('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE id=? AND deleted_at IS NULL)').bind(id),
  ]);
  if (!active.results.length) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '账单不存在。');
  return c.json({ data: { tagOverride: null } });
});
