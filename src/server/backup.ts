import { Hono } from 'hono';
import { z } from 'zod';
import type { Backup, BackupRestoreResult, Transaction, Category, RequestReceipt, WishlistItem } from '../shared/contracts';
import { TRANSACTION_KINDS, defaultCategoryAppearance, getTransactionCashflowKind } from '../shared/contracts';
import type { ApiEnv } from './types';
import { ApiError } from './errors';
import { mapAccount } from './platform';
import { toTransaction, type TransactionRow } from './ledger';
import { MAX_CENTS, normalizeDate, textId } from './ledger/domain';
import { categoryRuleInputSchema, toCategoryRule, type CategoryRuleRow } from './ledger/classification';
import { categorySchema, categoryNameKey, mapCategory, builtinCategorySeeds } from './ledger/categories';
import { wishlistItemSchema, toWishlistItem, type WishlistRow } from './wishlist';
import { tagRuleSchema, tagSchema, toTag, toTagRule, type TagRow, type TagRuleRow, type TransactionTagRow } from './ledger/tags';
import { backupBudgetSchema } from './budgets';
import tagSeeds from './ledger/tag-seeds.json';

const tagColumns = ['id', 'name', 'category_id', 'icon', 'position', 'version'];
const tagRuleColumns = ['id', 'tag_id', 'keyword', 'match_type', 'version'];

const date = z.string().max(40).transform(normalizeDate);
const sourceDetailsSchema = z.object({
  transactionType: z.string().min(1).max(40), direction: z.enum(['inflow', 'outflow']), parserVersion: z.string().min(1).max(40),
  transactionTimeRaw: z.string().max(100).optional(), balance: z.string().regex(/^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/).optional(),
});
const receiptSchema = z.object({
  transactionId: textId,
  scope: z.union([z.literal('manual'), z.string().startsWith('shortcut:').min(10).max(109),
    z.string().startsWith('mail:').min(6).max(105), z.string().startsWith('mail-manual:').min(13).max(112)]),
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const legacyTransactionSchema = z.object({
  id: textId, occurredAt: date, kind: z.enum(TRANSACTION_KINDS), amountCents: z.number().int().min(1).max(MAX_CENTS),
  currency: z.literal('CNY'), description: z.string().min(1).max(300), counterparty: z.string().max(200),
  categoryId: textId.nullable(), accountId: textId, source: z.enum(['manual', 'shortcut', 'import']),
  sourceDetails: sourceDetailsSchema.nullable(), fingerprint: z.string().max(1000).nullable(),
  reviewStatus: z.enum(['confirmed', 'pending']), note: z.string().max(2000), createdAt: date, updatedAt: date,
  deletedAt: date.nullable(), version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), isFixed: z.boolean(),
});
const categorizedTransactionSchema = legacyTransactionSchema.extend({
  categorySource: z.enum(['unclassified', 'manual', 'rule']), categoryRuleId: textId.nullable(),
  categoryRuleKeyword: z.string().min(1).max(100).nullable(),
});
const provenanceValid = (transaction: z.infer<typeof categorizedTransactionSchema>) => transaction.categorySource === 'rule'
  ? transaction.categoryId !== null && transaction.categoryRuleId !== null && transaction.categoryRuleKeyword !== null
  : transaction.categoryRuleId === null && transaction.categoryRuleKeyword === null && (transaction.categorySource !== 'unclassified' || transaction.categoryId === null);
const legacyCategorizedTransactionSchema = categorizedTransactionSchema.refine(transaction => provenanceValid(transaction) &&
  (transaction.categorySource !== 'rule' || transaction.kind !== 'transfer'), { message: '账目的分类来源与分类信息不一致。' });
const transactionSchema = categorizedTransactionSchema.extend({ fixedAutoExcluded: z.boolean().optional(), transferDirection: z.enum(['inflow', 'outflow']).nullable() })
  .refine(transaction => !(transaction.fixedAutoExcluded && transaction.isFixed) && (transaction.kind === 'transfer' || transaction.transferDirection === null) && provenanceValid(transaction) &&
    (transaction.categorySource !== 'rule' || getTransactionCashflowKind(transaction) !== 'transfer'),
    { message: '账目的资金方向或分类来源与信息不一致。' });
const ruleSchema = categoryRuleInputSchema.extend({ id: textId, source: z.literal('user'), version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
const backupFields = {
  format: z.literal('personal-dashboard'), exportedAt: date,
  accounts: z.array(z.object({ id: textId, name: z.string().min(1).max(60), bank: z.string().max(60), currency: z.literal('CNY'), archived: z.boolean() })),
  receipts: z.array(receiptSchema),
};
const legacyCategories = z.array(z.object({ id: textId, name: z.string().min(1).max(60), kind: z.enum(['expense', 'income', 'both']) }));
const backupSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ ...backupFields, categories: legacyCategories, schemaVersion: z.literal(1),
    transactions: z.array(legacyTransactionSchema.extend({ isFixed: z.literal(false).optional().default(false) })) }),
  z.object({ ...backupFields, categories: legacyCategories, schemaVersion: z.literal(2), transactions: z.array(legacyTransactionSchema) }),
  z.object({ ...backupFields, categories: legacyCategories, schemaVersion: z.literal(3), transactions: z.array(legacyCategorizedTransactionSchema), categoryRules: z.array(ruleSchema) }),
  z.object({ ...backupFields, categories: z.array(categorySchema), schemaVersion: z.literal(4), transactions: z.array(legacyCategorizedTransactionSchema), categoryRules: z.array(ruleSchema) }),
  z.object({ ...backupFields, categories: z.array(categorySchema), schemaVersion: z.literal(5), transactions: z.array(transactionSchema), categoryRules: z.array(ruleSchema) }),
  z.object({ ...backupFields, categories: z.array(categorySchema), schemaVersion: z.literal(6), transactions: z.array(transactionSchema), categoryRules: z.array(ruleSchema), wishlistItems: z.array(wishlistItemSchema) }),
  z.object({ ...backupFields, categories: z.array(categorySchema), schemaVersion: z.literal(7), transactions: z.array(transactionSchema), categoryRules: z.array(ruleSchema), wishlistItems: z.array(wishlistItemSchema), budget: backupBudgetSchema,
    tags: z.array(tagSchema).optional(), tagRules: z.array(tagRuleSchema).optional(),
    transactionTags: z.array(z.object({ transactionId: textId, categoryId: textId, tagId: textId.nullable() })).optional().default([]) }),
]);

/** Bound each JSON parameter below D1's row/string limit, including non-ASCII data. */
function chunks(rows: Record<string, unknown>[]): string[] {
  const groups: string[] = [];
  let parts: string[] = [], size = 2;
  const encoder = new TextEncoder();
  for (const row of rows) {
    const part = JSON.stringify(row), bytes = encoder.encode(part).length + 1;
    if (size + bytes > 750_000 && parts.length) { groups.push(`[${parts.join(',')}]`); parts = []; size = 2; }
    parts.push(part); size += bytes;
  }
  if (parts.length) groups.push(`[${parts.join(',')}]`);
  return groups;
}
const transactionColumns: Record<string, keyof Transaction> = {
  id: 'id', occurred_at: 'occurredAt', kind: 'kind', amount_cents: 'amountCents', currency: 'currency',
  description: 'description', counterparty: 'counterparty', category_id: 'categoryId', account_id: 'accountId',
  source: 'source', source_details: 'sourceDetails', fingerprint: 'fingerprint', review_status: 'reviewStatus', note: 'note',
  created_at: 'createdAt', updated_at: 'updatedAt', deleted_at: 'deletedAt', version: 'version', is_fixed: 'isFixed',
  transfer_direction: 'transferDirection', category_source: 'categorySource', category_rule_id: 'categoryRuleId', category_rule_keyword: 'categoryRuleKeyword',
};
const wishlistColumns: Record<string, keyof WishlistItem> = {
  id: 'id', title: 'title', brand: 'brand', amount_cents: 'amountCents', url: 'url', note: 'note', status: 'status',
  created_at: 'createdAt', updated_at: 'updatedAt', purchased_at: 'purchasedAt', deleted_at: 'deletedAt', version: 'version', position: 'position',
};

// SQLite json() preserves object-key order; normalize the known record fields before comparison.
// This treats equivalent source objects alike without touching or rewriting the existing row.
function canonicalSourceSql(expression: string): string {
  const fields = Object.keys(sourceDetailsSchema.shape).map(key => `'${key}',json_extract(${expression},'$.${key}')`).join(',');
  return `CASE WHEN ${expression} IS NULL THEN NULL ELSE json_object(${fields}) END`;
}

export const backupRoutes = new Hono<ApiEnv>();
backupRoutes.get('/backup', async c => {
  const [accounts, categories, transactions, rules, wishlist, budgetRows, tagRows, tagRuleRows, transactionTagRows] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM accounts ORDER BY id'), c.env.DB.prepare('SELECT * FROM categories ORDER BY id'),
    c.env.DB.prepare('SELECT * FROM transactions ORDER BY id'),
    c.env.DB.prepare('SELECT * FROM category_rules ORDER BY id'),
    c.env.DB.prepare('SELECT * FROM wishlist_items ORDER BY id'),
    c.env.DB.prepare('SELECT amount_cents FROM monthly_budget WHERE id=1'),
    c.env.DB.prepare('SELECT * FROM tags ORDER BY id'), c.env.DB.prepare('SELECT * FROM tag_rules ORDER BY id'),
    c.env.DB.prepare('SELECT * FROM transaction_tags ORDER BY transaction_id'),
  ]);
  const transactionRows = transactions.results as unknown as TransactionRow[];
  const receipts: RequestReceipt[] = transactionRows.flatMap(row => row.idempotency_scope === null ? [] : [{
    transactionId: row.id, scope: row.idempotency_scope, key: row.idempotency_key!, payloadHash: row.payload_hash!,
  }]);
  const data: Backup = { format: 'personal-dashboard', schemaVersion: 7, exportedAt: new Date().toISOString(),
    accounts: (accounts.results as Record<string, unknown>[]).map(mapAccount), categories: categories.results.map(mapCategory),
    transactions: transactionRows.map(row => ({ ...toTransaction(row), ...(row.fixed_auto_excluded ? { fixedAutoExcluded: true } : {}) })), receipts,
    categoryRules: (rules.results as unknown as CategoryRuleRow[]).map(toCategoryRule),
    wishlistItems: (wishlist.results as unknown as WishlistRow[]).map(toWishlistItem),
    tags: (tagRows.results as unknown as TagRow[]).map(toTag), tagRules: (tagRuleRows.results as unknown as TagRuleRow[]).map(toTagRule),
    transactionTags: (transactionTagRows.results as unknown as TransactionTagRow[]).map(row => ({ transactionId: row.transaction_id, categoryId: row.category_id, tagId: row.tag_id })),
    budget: (amount => amount === null || amount === undefined ? null : { amountCents: Number(amount) })((budgetRows.results[0] as { amount_cents: number | null } | undefined)?.amount_cents) };
  return c.json({ data });
});
backupRoutes.post('/backup/restore', async c => {
  const input = backupSchema.parse(await c.req.json());
  const backup = { ...input, wishlistItems: 'wishlistItems' in input ? input.wishlistItems : [],
    budget: 'budget' in input ? input.budget : null,
    categoryRules: 'categoryRules' in input ? input.categoryRules : [],
    categories: input.categories.map(category => input.schemaVersion >= 4 ? category as Category
      : { ...category, ...defaultCategoryAppearance(category.id), version: 1 }),
    transactions: input.transactions.map(transaction => {
      const transferDirection = transaction.kind === 'transfer' ? transaction.sourceDetails?.direction ?? null : null;
      if (input.schemaVersion >= 5) return transaction as Transaction & { fixedAutoExcluded?: boolean };
      if (input.schemaVersion === 3 || input.schemaVersion === 4) return { ...transaction, transferDirection } as Transaction;
      return { ...transaction, transferDirection,
        categorySource: transaction.categoryId !== null || transaction.version > 1 || transaction.source === 'manual' ? 'manual' as const : 'unclassified' as const,
        categoryRuleId: null, categoryRuleKeyword: null };
    }) };
  if (backup.transactions.some(transaction => transaction.isFixed && transaction.kind !== 'expense')) {
    throw new ApiError(422, 'INVALID_FIXED_EXPENSE', '只有支出可以标记为固定支出。');
  }
  for (const [name, rows] of Object.entries({ accounts: backup.accounts, categories: backup.categories, transactions: backup.transactions, categoryRules: backup.categoryRules, wishlistItems: backup.wishlistItems })) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new ApiError(422, 'DUPLICATE_ID', `备份的 ${name} 存在重复记录 ID。`);
  }
  if (new Set(backup.categories.map(category => categoryNameKey(category.name))).size !== backup.categories.length) {
    throw new ApiError(422, 'DUPLICATE_CATEGORY_NAME', '备份存在同名类目，未写入任何数据。');
  }
  const accountIds = new Set(backup.accounts.map(a => a.id)), categoryIds = new Set(backup.categories.map(a => a.id));
  if (backup.transactions.some(t => !accountIds.has(t.accountId) || (t.categoryId !== null && !categoryIds.has(t.categoryId)))) {
    throw new ApiError(422, 'INCOMPLETE_BACKUP', '备份缺少账目引用的账户或分类。');
  }
  const categoriesById = new Map(backup.categories.map(category => [category.id, category]));
  if (backup.transactions.some(transaction => {
    const category = transaction.categoryId === null ? null : categoriesById.get(transaction.categoryId);
    const flow = getTransactionCashflowKind(transaction);
    const kind = flow === 'refund' ? 'expense' : flow;
    return category && category.kind !== 'both' && category.kind !== kind;
  })) throw new ApiError(422, 'INVALID_CATEGORY_REFERENCE', '备份的账单分类与收支类型不匹配。');
  if (backup.categoryRules.some(rule => {
    const category = categoriesById.get(rule.categoryId);
    return !category || (category.kind !== 'both' && category.kind !== rule.kind);
  })) throw new ApiError(422, 'INVALID_CATEGORY_RULE', '备份的分类规则缺少有效分类，或收支类型不匹配。');
  const transactionIds = new Set(backup.transactions.map(t => t.id));
  const receiptsByTransaction = new Map(backup.receipts.map(receipt => [receipt.transactionId, receipt]));
  const receiptKeys = new Set(backup.receipts.map(receipt => JSON.stringify([receipt.scope, receipt.key])));
  if (receiptsByTransaction.size !== backup.receipts.length || receiptKeys.size !== backup.receipts.length) {
    throw new ApiError(422, 'DUPLICATE_RECEIPT', '备份的请求回执存在重复交易或请求标识。');
  }
  if (backup.receipts.some(receipt => !transactionIds.has(receipt.transactionId))) {
    throw new ApiError(422, 'INCOMPLETE_BACKUP', '备份中的请求回执缺少对应账目。');
  }
  const statements: D1PreparedStatement[] = [], insertIndices: number[] = [], wishlistInsertIndices: number[] = [];
  let budgetIndex = -1;
  const operationId = crypto.randomUUID();
  function addTable(table: string, rows: Record<string, unknown>[], columns: string[], countInResult?: number[], compareColumns = columns) {
    for (const json of chunks(rows)) {
      const values = columns.map(column => `json_extract(input.value,'$.${column}')`);
      const same = compareColumns.map(column => {
        const i = columns.indexOf(column);
        return column === 'source_details'
        ? `(${canonicalSourceSql(`existing.${column}`)}) IS (${canonicalSourceSql(values[i])})`
        : `existing.${column} IS ${values[i]}`;
      }).join(' AND ');
      // Constraint check and inserts execute in a single D1 batch transaction; concurrent edits cannot slip between them.
      statements.push(c.env.DB.prepare(`INSERT INTO restore_guards(id,valid) SELECT ?, CASE WHEN EXISTS(
        SELECT 1 FROM json_each(?) input JOIN ${table} existing ON existing.id=json_extract(input.value,'$.id') WHERE NOT (${same})
      ) THEN 0 ELSE 1 END`).bind(`${operationId}:${statements.length}`, json));
      countInResult?.push(statements.length);
      statements.push(c.env.DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${values.join(',')} FROM json_each(?) input WHERE true ON CONFLICT(id) DO NOTHING RETURNING id`).bind(json));
    }
  }
  if (input.schemaVersion === 7 && input.tags !== undefined && input.tagRules !== undefined) {
    // Replace the migration catalog only when both tables match the seed snapshot
    // exactly and the target ledger is empty. Keep this check inside the restore batch.
    const catalogSql = (table: string, columns: string[]) =>
      `(SELECT json_group_array(json_array(${columns.join(',')})) FROM (SELECT * FROM ${table} ORDER BY id))`;
    const seedGuard = `${operationId}:tag-seeds`;
    statements.push(c.env.DB.prepare(`INSERT INTO restore_guards(id,valid) SELECT ?,1
      WHERE NOT EXISTS(SELECT 1 FROM transactions)
        AND NOT EXISTS(SELECT 1 FROM transaction_tags)
        AND ${catalogSql('tags', tagColumns)} = ?
        AND ${catalogSql('tag_rules', tagRuleColumns)} = ?`)
      .bind(seedGuard, JSON.stringify(tagSeeds.tags), JSON.stringify(tagSeeds.tag_rules)));
    statements.push(c.env.DB.prepare('DELETE FROM tags WHERE EXISTS(SELECT 1 FROM restore_guards WHERE id=?)').bind(seedGuard));
  }
  addTable('accounts', backup.accounts.map(a => ({ ...a, archived: a.archived ? 1 : 0 })), ['id', 'name', 'bank', 'currency', 'archived']);
  if (input.schemaVersion >= 4) {
    const seeds = JSON.stringify(builtinCategorySeeds.map(category => ({ ...category, name_key: categoryNameKey(category.name) })));
    const columns = ['id', 'name', 'kind', 'icon', 'color', 'version', 'name_key'];
    const seedSignature = columns.map(column => `existing.${column} IS json_extract(seed.value,'$.${column}')`).join(' AND ');
    const differs = columns.map(column => `existing.${column} IS json_extract(input.value,'$.${column}')`).join(' AND ');
    const categoryChunks = chunks(backup.categories.map(category => ({ ...category, name_key: categoryNameKey(category.name) })));
    const markerPrefix = `${operationId}:categoryseed:`;
    for (const json of categoryChunks) {
      // A new empty database already contains default categories. Replace only
      // exact, unused migration seeds; never overwrite user edits or used data.
      statements.push(c.env.DB.prepare(`INSERT INTO restore_guards(id,valid)
        SELECT ?||existing.id,1 FROM categories existing JOIN json_each(?) input ON existing.id=json_extract(input.value,'$.id')
        WHERE NOT (${differs}) AND EXISTS(SELECT 1 FROM json_each(?) seed WHERE ${seedSignature})
          AND NOT EXISTS(SELECT 1 FROM transactions WHERE category_id=existing.id)
          AND NOT EXISTS(SELECT 1 FROM category_rules WHERE category_id=existing.id)`)
        .bind(markerPrefix, json, seeds));
    }
    // Release all candidate names before any replacement, including candidates
    // in different JSON chunks, so exchanging names has no transient collision.
    statements.push(c.env.DB.prepare('UPDATE categories SET name_key=NULL WHERE EXISTS(SELECT 1 FROM restore_guards WHERE id=?||categories.id)')
      .bind(markerPrefix));
    const updates = columns.filter(column => column !== 'id').map(column =>
      `${column}=(SELECT json_extract(value,'$.${column}') FROM json_each(?) WHERE json_extract(value,'$.id')=categories.id)`);
    for (const json of categoryChunks) {
      statements.push(c.env.DB.prepare(`UPDATE categories SET ${updates.join(',')}
        WHERE EXISTS(SELECT 1 FROM restore_guards WHERE id=?||categories.id)
          AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`)
        .bind(...updates.map(() => json), markerPrefix, json));
    }
  }
  addTable('categories', backup.categories.map(category => ({ ...category, name_key: categoryNameKey(category.name) })),
    ['id', 'name', 'kind', 'icon', 'color', 'version', 'name_key'], undefined, input.schemaVersion >= 4
      ? ['id', 'name', 'kind', 'icon', 'color', 'version', 'name_key'] : ['id', 'name', 'kind']);
  addTable('category_rules', backup.categoryRules.map(rule => ({ id: rule.id, keyword: rule.keyword,
    match_type: rule.matchType, kind: rule.kind, category_id: rule.categoryId, enabled: rule.enabled ? 1 : 0, version: rule.version,
  })), ['id', 'keyword', 'match_type', 'kind', 'category_id', 'enabled', 'version']);
  const rows = backup.transactions.map(transaction => {
    const receipt = receiptsByTransaction.get(transaction.id);
    return {
      ...Object.fromEntries(Object.entries(transactionColumns).map(([column, key]) => [column,
        key === 'sourceDetails' ? (transaction.sourceDetails ? JSON.stringify(transaction.sourceDetails) : null)
          : key === 'isFixed' ? (transaction.isFixed ? 1 : 0) : transaction[key],
      ])),
      fixed_auto_excluded: 'fixedAutoExcluded' in transaction ? Number(Boolean(transaction.fixedAutoExcluded)) : 0,
      idempotency_scope: receipt?.scope ?? null, idempotency_key: receipt?.key ?? null, payload_hash: receipt?.payloadHash ?? null,
    };
  });
  const columns = [...Object.keys(transactionColumns), 'fixed_auto_excluded', 'idempotency_scope', 'idempotency_key', 'payload_hash'];
  // Older backups never carried an explicit ledger direction. Keep an existing
  // user's chosen direction, while deriving directions for missing records.
  addTable('transactions', rows, columns, insertIndices, input.schemaVersion >= 5 ? columns : columns.filter(column => column !== 'transfer_direction'));
  addTable('wishlist_items', backup.wishlistItems.map(item => Object.fromEntries(
    Object.entries(wishlistColumns).map(([column, key]) => [column, item[key]]),
  )), Object.keys(wishlistColumns), wishlistInsertIndices, Object.keys(wishlistColumns).filter(column => column !== 'position'));
  const tags = 'tags' in input ? input.tags ?? [] : [];
  const tagRules = 'tagRules' in input ? input.tagRules ?? [] : [];
  const tagsById = new Map(tags.map(tag => [tag.id, tag]));
  if (tags.some(tag => !categoryIds.has(tag.categoryId))) {
    throw new ApiError(422, 'INCOMPLETE_BACKUP', '备份的二级标签缺少对应分类。');
  }
  addTable('tags', tags.map(tag => ({ id: tag.id, name: tag.name, category_id: tag.categoryId,
    icon: tag.icon, position: tag.position, version: tag.version })), tagColumns);
  addTable('tag_rules', tagRules.filter(rule => tagsById.has(rule.tagId)).map(rule => ({ id: rule.id, tag_id: rule.tagId, keyword: rule.keyword,
    match_type: rule.matchType, version: rule.version })), tagRuleColumns);
  // 手动指定的二级标签：账单与标签都存在时才补入，已有的手动指定保持现状。
  const transactionTags = 'transactionTags' in input ? input.transactionTags : [];
  for (const json of chunks(transactionTags.map(row => ({ transaction_id: row.transactionId, category_id: row.categoryId, tag_id: row.tagId })))) {
    statements.push(c.env.DB.prepare(`INSERT INTO transaction_tags(transaction_id,category_id,tag_id) SELECT json_extract(value,'$.transaction_id'),json_extract(value,'$.category_id'),json_extract(value,'$.tag_id')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM transactions WHERE id=json_extract(value,'$.transaction_id'))
        AND EXISTS(SELECT 1 FROM categories WHERE id=json_extract(value,'$.category_id'))
        AND (json_extract(value,'$.tag_id') IS NULL OR EXISTS(SELECT 1 FROM tags WHERE id=json_extract(value,'$.tag_id'))) ON CONFLICT DO NOTHING`).bind(json));
  }
  // Monthly budget: fill it when unset, keep an identical amount, refuse a different existing amount.
  if (backup.budget) {
    statements.push(c.env.DB.prepare(`INSERT INTO restore_guards(id,valid) SELECT ?, CASE WHEN amount_cents IS NOT NULL AND amount_cents!=? THEN 0 ELSE 1 END FROM monthly_budget WHERE id=1`)
      .bind(`${operationId}:budget`, backup.budget.amountCents));
    budgetIndex = statements.length;
    statements.push(c.env.DB.prepare('UPDATE monthly_budget SET amount_cents=?,version=version+1,updated_at=? WHERE id=1 AND amount_cents IS NULL RETURNING id')
      .bind(backup.budget.amountCents, new Date().toISOString()));
  }
  statements.push(c.env.DB.prepare('DELETE FROM restore_guards WHERE id LIKE ?').bind(`${operationId}:%`));
  try {
    const results = await c.env.DB.batch(statements);
    const inserted = insertIndices.reduce((sum, index) => sum + results[index].results.length, 0);
    const wishlistInserted = wishlistInsertIndices.reduce((sum, index) => sum + results[index].results.length, 0);
    const data: BackupRestoreResult = { inserted, skipped: backup.transactions.length - inserted,
      wishlistInserted, wishlistSkipped: backup.wishlistItems.length - wishlistInserted,
      budgetRestored: budgetIndex >= 0 && results[budgetIndex].results.length > 0 };
    return c.json({ data });
  } catch (error) {
    if (error instanceof Error && /constraint|UNIQUE|FOREIGN KEY/i.test(error.message)) throw new ApiError(409, 'RESTORE_CONFLICT', '备份与当前数据存在账目、心愿单、预算、分类规则、二级标签、请求回执或同名账户冲突，未写入任何数据。请先核对。');
    throw error;
  }
});
