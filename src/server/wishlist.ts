import { Hono } from 'hono';
import { z } from 'zod';
import type { WishlistItem, WishlistPage } from '../shared/contracts';
import type { ApiEnv } from './types';
import { ApiError } from './errors';
import { digest } from './security';
import { MAX_CENTS, normalizeDate, parseAmount, versionSchema } from './ledger/domain';

const itemId = z.uuid();
const titleSchema = z.string().trim().min(1).max(200);
const noteSchema = z.string().trim().max(2000);
const brandSchema = z.string().trim().max(100);
const statusSchema = z.enum(['wanted', 'purchased']);
const urlSchema = z.string().trim().max(2000).refine(value => {
  if (!value) return true;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch { return false; }
}, '商品链接须为不含账号密码的 http 或 https 地址。');
const inputSchema = z.object({ title: titleSchema, brand: brandSchema.default(''), amount: z.string().trim().max(20).nullable(), url: urlSchema.default(''), note: noteSchema });
const dateSchema = z.string().max(40).transform(normalizeDate);
export const wishlistItemSchema = z.object({
  id: itemId, title: titleSchema, brand: brandSchema.optional().default(''), amountCents: z.number().int().min(1).max(MAX_CENTS).nullable(),
  url: urlSchema, note: noteSchema, status: statusSchema,
  createdAt: dateSchema, updatedAt: dateSchema, purchasedAt: dateSchema.nullable(), deletedAt: dateSchema.nullable(),
  version: versionSchema.shape.version,
  position: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional().default(null),
}).refine(item => (item.status === 'purchased') === (item.purchasedAt !== null), '心愿的购买状态与购买时间不一致。');

export interface WishlistRow {
  id: string; title: string; brand: string | null; amount_cents: number | null; url: string; note: string; status: WishlistItem['status'];
  created_at: string; updated_at: string; purchased_at: string | null; deleted_at: string | null; version: number;
  create_payload_hash: string | null; position: number | null;
}
export function toWishlistItem(row: WishlistRow): WishlistItem {
  return { id: row.id, title: row.title, brand: row.brand ?? '', amountCents: row.amount_cents, url: row.url, note: row.note, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, purchasedAt: row.purchased_at, deletedAt: row.deleted_at, version: row.version,
    position: row.position === null || row.position === undefined ? null : Number(row.position) };
}
function normalizedInput(input: z.infer<typeof inputSchema>) {
  return { title: input.title, brand: input.brand, amountCents: input.amount === null ? null : parseAmount(input.amount), url: input.url, note: input.note };
}
async function changedItem(db: D1Database, id: string, row: WishlistRow | null): Promise<WishlistItem> {
  if (row) return toWishlistItem(row);
  const exists = await db.prepare('SELECT id FROM wishlist_items WHERE id=?').bind(id).first();
  if (!exists) throw new ApiError(404, 'WISHLIST_NOT_FOUND', '这项心愿不存在。');
  throw new ApiError(409, 'WISHLIST_VERSION_CONFLICT', '这项心愿已发生变化，请刷新后重新操作。');
}

export const wishlistRoutes = new Hono<ApiEnv>();
wishlistRoutes.get('/wishlist', async c => {
  const { status, search, page } = z.object({
    status: z.enum(['wanted', 'purchased', 'deleted']).default('wanted'), search: z.string().trim().max(200).default(''),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  }).parse(c.req.query());
  const pageSize = 30;
  // Literal substring search: a pasted '%' or '_' is not an SQL wildcard.
  const searchWhere = "(?='' OR instr(lower(title),lower(?))>0 OR instr(lower(note),lower(?))>0 OR instr(lower(brand),lower(?))>0)";
  const stateWhere = status === 'deleted' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL AND status=?';
  // 想买按手动排队顺序；已购、已移除按发生时间倒序
  const order = status === 'purchased' ? 'purchased_at DESC,id DESC' : status === 'deleted' ? 'deleted_at DESC,id DESC'
    : 'position IS NULL,position ASC,created_at DESC,id DESC';
  const searchBindings = [search, search, search, search];
  const bindings = [...searchBindings, ...(status === 'deleted' ? [] : [status])];
  const [countsResult, summaryResult, itemsResult] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COALESCE(SUM(deleted_at IS NULL AND status='wanted'),0) AS wanted,
      COALESCE(SUM(deleted_at IS NULL AND status='purchased'),0) AS purchased,
      COALESCE(SUM(deleted_at IS NOT NULL),0) AS deleted FROM wishlist_items WHERE ${searchWhere}`).bind(...searchBindings),
    c.env.DB.prepare(`SELECT COUNT(*) AS total,COUNT(amount_cents) AS pricedCount,COALESCE(SUM(amount_cents),0) AS totalAmountCents
      FROM wishlist_items WHERE ${searchWhere} AND ${stateWhere}`).bind(...bindings),
    c.env.DB.prepare(`SELECT * FROM wishlist_items WHERE ${searchWhere} AND ${stateWhere}
      ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...bindings, pageSize, (page - 1) * pageSize),
  ]);
  const summary = summaryResult.results[0] as { total: number; pricedCount: number; totalAmountCents: number };
  const data: WishlistPage = { items: (itemsResult.results as unknown as WishlistRow[]).map(toWishlistItem),
    ...summary, page, pageSize, counts: countsResult.results[0] as WishlistPage['counts'] };
  return c.json({ data });
});
wishlistRoutes.get('/wishlist/:id', async c => {
  const id = itemId.parse(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT * FROM wishlist_items WHERE id=?').bind(id).first<WishlistRow>();
  if (!row) throw new ApiError(404, 'WISHLIST_NOT_FOUND', '这项心愿不存在。');
  return c.json({ data: toWishlistItem(row) });
});
wishlistRoutes.post('/wishlist', async c => {
  const { id, ...input } = inputSchema.extend({ id: itemId }).parse(await c.req.json());
  const value = normalizedInput(input), now = new Date().toISOString();
  const hash = await digest(JSON.stringify(value));
  const row = await c.env.DB.prepare(`INSERT INTO wishlist_items(id,title,brand,amount_cents,url,note,created_at,updated_at,create_payload_hash,position)
    VALUES(?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM wishlist_items)) ON CONFLICT(id) DO NOTHING RETURNING *`)
    .bind(id, value.title, value.brand, value.amountCents, value.url, value.note, now, now, hash).first<WishlistRow>();
  if (row) return c.json({ data: toWishlistItem(row) }, 201);
  const existing = await c.env.DB.prepare('SELECT * FROM wishlist_items WHERE id=?').bind(id).first<WishlistRow>();
  if (!existing || existing.create_payload_hash !== hash) throw new ApiError(409, 'WISHLIST_CREATE_CONFLICT', '这次添加请求已被使用，请刷新后核对心愿单。');
  // Compare against the original request, even if this item has since been edited or removed.
  return c.json({ data: toWishlistItem(existing) });
});
wishlistRoutes.put('/wishlist/:id', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version, ...input } = inputSchema.extend({ version: versionSchema.shape.version }).parse(await c.req.json());
  const value = normalizedInput(input);
  const row = await c.env.DB.prepare(`UPDATE wishlist_items SET title=?,brand=?,amount_cents=?,url=?,note=?,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND deleted_at IS NULL RETURNING *`)
    .bind(value.title, value.brand, value.amountCents, value.url, value.note, new Date().toISOString(), id, version).first<WishlistRow>();
  return c.json({ data: await changedItem(c.env.DB, id, row) });
});
wishlistRoutes.post('/wishlist/:id/status', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { status, version } = z.object({ status: statusSchema, version: versionSchema.shape.version }).parse(await c.req.json());
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare(`UPDATE wishlist_items
    SET status=?,purchased_at=CASE WHEN ?='wanted' THEN NULL ELSE COALESCE(purchased_at,?) END,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND deleted_at IS NULL RETURNING *`)
    .bind(status, status, now, now, id, version).first<WishlistRow>();
  return c.json({ data: await changedItem(c.env.DB, id, row) });
});
wishlistRoutes.delete('/wishlist/:id', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version } = versionSchema.parse(await c.req.json());
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare(`UPDATE wishlist_items SET deleted_at=?,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND deleted_at IS NULL RETURNING *`)
    .bind(now, now, id, version).first<WishlistRow>();
  return c.json({ data: await changedItem(c.env.DB, id, row) });
});
wishlistRoutes.post('/wishlist/:id/restore', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { version } = versionSchema.parse(await c.req.json());
  const row = await c.env.DB.prepare(`UPDATE wishlist_items SET deleted_at=NULL,updated_at=?,version=version+1
    WHERE id=? AND version=? AND version<9007199254740991 AND deleted_at IS NOT NULL RETURNING *`)
    .bind(new Date().toISOString(), id, version).first<WishlistRow>();
  return c.json({ data: await changedItem(c.env.DB, id, row) });
});

/* 调整排队顺序：把一项想买的心愿移到第 position 位（从 1 开始），其余顺延；整体在一个批次里重排 */
wishlistRoutes.post('/wishlist/:id/position', async c => {
  const id = itemId.parse(c.req.param('id'));
  const { position } = z.object({ position: z.number().int().min(1).max(1_000_000) }).parse(await c.req.json());
  const rows = (await c.env.DB.prepare(`SELECT id FROM wishlist_items WHERE deleted_at IS NULL AND status='wanted'
    ORDER BY position IS NULL,position ASC,created_at DESC,id DESC`).all()).results as { id: string }[];
  const ids = rows.map(row => row.id);
  if (!ids.includes(id)) {
    const exists = await c.env.DB.prepare('SELECT id FROM wishlist_items WHERE id=?').bind(id).first();
    if (!exists) throw new ApiError(404, 'WISHLIST_NOT_FOUND', '这项心愿不存在。');
    throw new ApiError(409, 'WISHLIST_NOT_QUEUED', '只有想买的心愿可以调整顺序，请刷新后重试。');
  }
  const next = ids.filter(item => item !== id);
  next.splice(Math.min(position, ids.length) - 1, 0, id);
  // Purchased and removed items keep their slot numbers after the queue, so restoring them never collides.
  const offset = await c.env.DB.prepare(`SELECT COALESCE(MAX(position),0) AS top FROM wishlist_items`).first<{ top: number }>();
  const base = Number(offset?.top ?? 0) + 1;
  await c.env.DB.batch([
    ...next.map((item, index) => c.env.DB.prepare('UPDATE wishlist_items SET position=? WHERE id=?').bind(base + index, item)),
  ]);
  const data: WishlistItem[] = (await c.env.DB.prepare(`SELECT * FROM wishlist_items WHERE id IN (${next.map(() => '?').join(',')})
    ORDER BY position ASC`).bind(...next).all()).results.map(row => toWishlistItem(row as unknown as WishlistRow));
  return c.json({ data });
});
