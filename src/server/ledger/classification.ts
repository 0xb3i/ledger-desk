import { Hono } from 'hono';
import { z } from 'zod';
import { getTransactionCashflowKind, type TransferDirection } from '../../shared/contracts';
import type { Category, CategoryPreview, CategoryPreviewItem, CategoryRule, CategoryRuleInput, CategoryRuleMutationResult, CategoryRuleDeleteResult, CategoryRuleDraftPreview, TransactionKind } from '../../shared/contracts';
import type { ApiEnv } from '../types';
import { ApiError, invalid } from '../errors';
import { hashPayload, textId, versionSchema } from './domain';
import { mapCategory } from './categories';

export const categoryRuleInputSchema = z.object({
  keyword: z.string().trim().min(1).max(100), matchType: z.enum(['contains', 'exact']),
  kind: z.enum(['expense', 'income']), categoryId: textId, enabled: z.boolean(),
});
export interface CategoryRuleRow {
  id: string; keyword: string; match_type: CategoryRule['matchType']; kind: CategoryRule['kind'];
  category_id: string; enabled: number; version: number;
}
export function toCategoryRule(row: CategoryRuleRow): CategoryRule {
  return { id: row.id, keyword: row.keyword, matchType: row.match_type, kind: row.kind,
    categoryId: row.category_id, enabled: row.enabled === 1, source: 'user', version: row.version };
}

const builtinDefinitions: [string, string, string][] = [
  ['transport:taxi', '打车', 'transport'], ['transport:metro', '地铁', 'transport'], ['transport:parking', '停车', 'transport'],
  ['transport:meituan-bike', '美团骑行', 'transport'], ['transport:meituan-bikeshare', '美团单车', 'transport'],
  ['leisure:beads', '拼豆', 'leisure'], ['leisure:cinema', '电影', 'leisure'],
  ['food:dining', '餐饮', 'food'], ['food:restaurant', '餐厅', 'food'], ['food:coffee', '咖啡', 'food'], ['food:tea', '奶茶', 'food'],
  ['housing:rent', '房租', 'housing'], ['housing:utilities', '水电费', 'housing'],
  ['health:pharmacy', '药房', 'health'], ['health:hospital', '医院', 'health'], ['learning:bookshop', '书店', 'learning'],
];
export const builtinCategoryRules: readonly CategoryRule[] = builtinDefinitions.map(([id, keyword, categoryId]) => ({
  id: `builtin:${id}`, keyword, categoryId, matchType: 'contains', kind: 'expense', enabled: true, source: 'builtin', version: 1,
}));
const isBuiltinId = (id: string) => builtinCategoryRules.some(rule => rule.id === id);

export function normalizeCategoryText(value: string): string { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase(); }
export function effectiveRules(rows: CategoryRuleRow[], categories: Category[]): CategoryRule[] {
  const byId = new Map(builtinCategoryRules.map(rule => [rule.id, rule]));
  for (const row of rows) byId.set(row.id, toCategoryRule(row));
  return [...byId.values()].filter(rule => categories.some(category => category.id === rule.categoryId &&
    (category.kind === 'both' || category.kind === rule.kind))).sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
export async function listCategoryRules(db: D1Database): Promise<CategoryRule[]> {
  const [rules, categories] = await db.batch([
    db.prepare('SELECT * FROM category_rules ORDER BY id'), db.prepare('SELECT * FROM categories ORDER BY id'),
  ]);
  return effectiveRules(rules.results as unknown as CategoryRuleRow[], categories.results.map(mapCategory));
}

export type CategoryMatch = { status: 'matched'; rule: CategoryRule } | { status: 'unmatched' | 'conflict' };
/** The only keyword matcher, shared by new ingestion and existing-record preview/application. */
export function matchCategory(input: { kind: TransactionKind; transferDirection?: TransferDirection | null; description: string; counterparty: string }, rules: readonly CategoryRule[]): CategoryMatch {
  const flow = getTransactionCashflowKind({ kind: input.kind, transferDirection: input.transferDirection ?? null });
  if (flow === 'transfer') return { status: 'unmatched' };
  const kind = flow === 'refund' ? 'expense' : flow;
  const text = [normalizeCategoryText(input.description), normalizeCategoryText(input.counterparty)];
  const matches = rules.filter(rule => rule.enabled && rule.kind === kind && text.some(value => {
    const keyword = normalizeCategoryText(rule.keyword);
    return keyword.length > 0 && (rule.matchType === 'exact' ? value === keyword : value.includes(keyword));
  }));
  // 更具体的关键词优先：两个命中的关键词若一个包含另一个（如「美团骑行」⊃「美团」），只保留更具体的那个，
  // 不论来源；互不包含的再按「用户规则优先于内置规则」处理，仍指向不同分类时判为冲突。
  const specific = matches.filter(rule => {
    const keyword = normalizeCategoryText(rule.keyword);
    return !matches.some(other => { const longer = normalizeCategoryText(other.keyword); return longer.length > keyword.length && longer.includes(keyword); });
  });
  const users = specific.filter(rule => rule.source === 'user');
  const candidates = users.length ? users : specific;
  if (!candidates.length) return { status: 'unmatched' };
  if (new Set(candidates.map(rule => rule.categoryId)).size > 1) return { status: 'conflict' };
  // Stable attribution when several rules agree; it never decides between categories.
  return { status: 'matched', rule: [...candidates].sort((a, b) => a.id.localeCompare(b.id, 'en'))[0] };
}

function ruleConflict(): never { throw new ApiError(409, 'RULE_VERSION_CONFLICT', '账单或规则已发生变化，请刷新后重新操作。'); }

export interface ClassificationTransaction {
  id: string; version: number; description: string; counterparty: string; kind: TransactionKind; transferDirection: TransferDirection | null;
  amount_cents: number; occurred_at: string; category_id: string | null;
  category_source: 'unclassified' | 'rule' | 'manual'; category_rule_id: string | null; category_rule_keyword: string | null;
  deleted_at: string | null;
}
export interface ClassificationState { revision: number; ruleRows: CategoryRuleRow[]; categories: Category[]; transactions: ClassificationTransaction[] }
const classificationColumns = `id,version,description,counterparty,kind,amount_cents,occurred_at,
  category_id,category_source,category_rule_id,category_rule_keyword,deleted_at,transfer_direction AS transferDirection`;
export async function readClassificationState(db: D1Database, { allTransactions = false } = {}): Promise<ClassificationState> {
  const [generation, rules, categories, eligible] = await db.batch([
    db.prepare('SELECT revision FROM classification_state WHERE id=1'), db.prepare('SELECT * FROM category_rules ORDER BY id'),
    db.prepare('SELECT * FROM categories ORDER BY id'), db.prepare(`SELECT ${classificationColumns} FROM transactions
      ${allTransactions ? '' : "WHERE deleted_at IS NULL AND category_source IN ('unclassified','rule') AND (kind!='transfer' OR transfer_direction IS NOT NULL)"} ORDER BY id`),
  ]);
  return { revision: (generation.results[0] as { revision: number }).revision,
    ruleRows: rules.results as unknown as CategoryRuleRow[], categories: categories.results.map(mapCategory),
    transactions: eligible.results as unknown as ClassificationTransaction[] };
}
export async function classificationPlan(state: ClassificationState, rules = effectiveRules(state.ruleRows, state.categories)): Promise<CategoryPreview> {
  const items: CategoryPreviewItem[] = [];
  let unmatchedCount = 0, conflictCount = 0;
  for (const row of state.transactions) {
    if (row.deleted_at !== null || row.category_source === 'manual' || row.kind === 'transfer' && row.transferDirection === null) continue;
    const match = matchCategory(row, rules);
    const categoryId = match.status === 'matched' ? match.rule.categoryId : null;
    const ruleId = match.status === 'matched' ? match.rule.id : null;
    const keyword = match.status === 'matched' ? match.rule.keyword : null;
    if (match.status === 'conflict') conflictCount++;
    if (match.status === 'unmatched') unmatchedCount++;
    // Reconcile both the category and its attribution. Unchanged records keep their version and audit.
    if (row.category_id === categoryId && row.category_rule_id === ruleId && row.category_rule_keyword === keyword &&
        row.category_source === (categoryId === null ? 'unclassified' : 'rule')) continue;
    items.push({ transactionId: row.id, version: row.version, description: row.description,
      kind: row.kind, amountCents: row.amount_cents, occurredAt: row.occurred_at,
      transferDirection: row.transferDirection, previousCategoryId: row.category_id, categoryId, ruleId, keyword });
  }
  const snapshot = await hashPayload({ revision: state.revision, rules, items, unmatchedCount, conflictCount });
  return { snapshot, items, matchedCount: items.length, unmatchedCount, conflictCount };
}
export function categoryUpdateStatements(db: D1Database, items: CategoryPreviewItem[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [], now = new Date().toISOString();
  for (let offset = 0; offset < items.length; offset += 100) {
    const json = JSON.stringify(items.slice(offset, offset + 100));
    const item = (field: string) => `(SELECT json_extract(value,'$.${field}') FROM json_each(?) WHERE json_extract(value,'$.transactionId')=transactions.id)`;
    statements.push(db.prepare(`UPDATE transactions SET category_id=${item('categoryId')},
      category_source=CASE WHEN ${item('categoryId')} IS NULL THEN 'unclassified' ELSE 'rule' END,
      category_rule_id=${item('ruleId')},category_rule_keyword=${item('keyword')},updated_at=?,version=version+1
      WHERE id IN (SELECT json_extract(value,'$.transactionId') FROM json_each(?)) RETURNING id`).bind(json, json, json, json, now, json));
  }
  return statements;
}
/** The revision check, rule mutation and category/audit updates commit as one transaction. */
async function commitClassification(db: D1Database, state: ClassificationState, preview: CategoryPreview,
  mutation?: D1PreparedStatement): Promise<number> {
  const guardId = `classification:${crypto.randomUUID()}`;
  const updates = categoryUpdateStatements(db, preview.items);
  const statements = [db.prepare(`INSERT INTO restore_guards(id,valid)
    VALUES(?,CASE WHEN (SELECT revision FROM classification_state WHERE id=1)=? THEN 1 ELSE 0 END)`).bind(guardId, state.revision),
    ...(mutation ? [mutation] : []), ...updates, db.prepare('DELETE FROM restore_guards WHERE id=?').bind(guardId)];
  const results = await db.batch(statements);
  return results.slice(mutation ? 2 : 1, -1).reduce((sum, result) => sum + result.results.length, 0);
}
function validateCategoryFromState(state: ClassificationState, input: CategoryRuleInput): void {
  const category = state.categories.find(category => category.id === input.categoryId);
  if (!category || (category.kind !== 'both' && category.kind !== input.kind)) invalid('请选择与收支类型匹配的分类。');
}
async function saveRule(db: D1Database, state: ClassificationState, next: CategoryRuleRow,
  mutation: D1PreparedStatement): Promise<CategoryRuleMutationResult> {
  const ruleRows = [...state.ruleRows.filter(row => row.id !== next.id), next];
  const preview = await classificationPlan(state, effectiveRules(ruleRows, state.categories));
  try {
    const updatedTransactions = await commitClassification(db, state, preview, mutation);
    return { ...toCategoryRule(next), updatedTransactions };
  } catch (error) {
    if (error instanceof Error && /constraint/i.test(error.message)) ruleConflict();
    throw error;
  }
}
export async function createCategoryRule(db: D1Database, input: CategoryRuleInput): Promise<CategoryRuleMutationResult> {
  const value = categoryRuleInputSchema.parse(input), state = await readClassificationState(db);
  validateCategoryFromState(state, value);
  const next: CategoryRuleRow = { id: crypto.randomUUID(), keyword: value.keyword, match_type: value.matchType,
    kind: value.kind, category_id: value.categoryId, enabled: value.enabled ? 1 : 0, version: 1 };
  const mutation = db.prepare(`INSERT INTO category_rules(id,keyword,match_type,kind,category_id,enabled,version)
    VALUES(?,?,?,?,?,?,1)`).bind(next.id, next.keyword, next.match_type, next.kind, next.category_id, next.enabled);
  return saveRule(db, state, next, mutation);
}
export async function updateCategoryRule(db: D1Database, id: string, input: CategoryRuleInput, version: number): Promise<CategoryRuleMutationResult> {
  const value = categoryRuleInputSchema.parse(input), state = await readClassificationState(db);
  const current = effectiveRules(state.ruleRows, state.categories).find(rule => rule.id === id);
  if (!current) throw new ApiError(404, 'RULE_NOT_FOUND', '分类规则不存在。');
  if (current.version !== version) ruleConflict();
  validateCategoryFromState(state, value);
  const next: CategoryRuleRow = { id, keyword: value.keyword, match_type: value.matchType, kind: value.kind,
    category_id: value.categoryId, enabled: value.enabled ? 1 : 0, version: version + 1 };
  const mutation = current.source === 'builtin'
    ? db.prepare(`INSERT INTO category_rules(id,keyword,match_type,kind,category_id,enabled,version)
        VALUES(?,?,?,?,?,?,?)`).bind(id, next.keyword, next.match_type, next.kind, next.category_id, next.enabled, next.version)
    : db.prepare(`UPDATE category_rules SET keyword=?,match_type=?,kind=?,category_id=?,enabled=?,version=? WHERE id=? AND version=?`)
        .bind(next.keyword, next.match_type, next.kind, next.category_id, next.enabled, next.version, id, version);
  return saveRule(db, state, next, mutation);
}
export async function deleteCategoryRule(db: D1Database, id: string, version: number): Promise<CategoryRuleDeleteResult> {
  if (isBuiltinId(id)) {
    const current = (await listCategoryRules(db)).find(rule => rule.id === id);
    if (!current) throw new ApiError(404, 'RULE_NOT_FOUND', '分类规则不存在。');
    const result = await updateCategoryRule(db, id, { ...current, enabled: false }, version);
    return { deleted: true, updatedTransactions: result.updatedTransactions };
  }
  const state = await readClassificationState(db), current = state.ruleRows.find(rule => rule.id === id);
  if (!current) throw new ApiError(404, 'RULE_NOT_FOUND', '分类规则不存在。');
  if (current.version !== version) ruleConflict();
  const preview = await classificationPlan(state, effectiveRules(state.ruleRows.filter(rule => rule.id !== id), state.categories));
  try {
    const updatedTransactions = await commitClassification(db, state, preview,
      db.prepare('DELETE FROM category_rules WHERE id=? AND version=?').bind(id, version));
    return { deleted: true, updatedTransactions };
  } catch (error) {
    if (error instanceof Error && /constraint/i.test(error.message)) ruleConflict();
    throw error;
  }
}
export async function previewCategories(db: D1Database): Promise<CategoryPreview> { return classificationPlan(await readClassificationState(db)); }
/** Simulate the same full reconciliation as save, without writing rules, transactions or a usable apply token. */
export async function previewCategoryRuleDraft(db: D1Database, input: CategoryRuleInput,
  editing?: { id: string; version: number }): Promise<CategoryRuleDraftPreview> {
  const value = categoryRuleInputSchema.parse(input), state = await readClassificationState(db);
  validateCategoryFromState(state, value);
  if (editing) {
    const current = effectiveRules(state.ruleRows, state.categories).find(rule => rule.id === editing.id);
    if (!current) throw new ApiError(404, 'RULE_NOT_FOUND', '分类规则不存在。');
    if (current.version !== editing.version) ruleConflict();
  }
  const next: CategoryRuleRow = { id: editing?.id ?? crypto.randomUUID(), keyword: value.keyword,
    match_type: value.matchType, kind: value.kind, category_id: value.categoryId,
    enabled: value.enabled ? 1 : 0, version: editing ? editing.version + 1 : 1 };
  const rules = effectiveRules([...state.ruleRows.filter(rule => rule.id !== next.id), next], state.categories);
  const plan = await classificationPlan(state, rules);
  // Predict visible category changes only: equivalent-rule attribution can depend on a new rule's eventual UUID.
  const changes = plan.items.filter(item => item.previousCategoryId !== item.categoryId)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.transactionId.localeCompare(b.transactionId));
  return { changedCount: changes.length, conflictCount: plan.conflictCount, items: changes.slice(0, 5) };
}
function stalePreview(): never { throw new ApiError(409, 'CLASSIFICATION_PREVIEW_STALE', '账单或规则已变化，请重新预览后再应用。'); }
export async function applyCategories(db: D1Database, snapshot: string): Promise<{ updated: number }> {
  const state = await readClassificationState(db), preview = await classificationPlan(state);
  if (snapshot !== preview.snapshot) stalePreview();
  try { return { updated: await commitClassification(db, state, preview) }; }
  catch (error) {
    if (error instanceof Error && /constraint/i.test(error.message)) stalePreview();
    throw error;
  }
}

export const categoryRuleRoutes = new Hono<ApiEnv>();
categoryRuleRoutes.get('/category-rules', async c => c.json({ data: { items: await listCategoryRules(c.env.DB) } }));
categoryRuleRoutes.get('/category-rules/preview', async c => c.json({ data: await previewCategories(c.env.DB) }));
categoryRuleRoutes.post('/category-rules/preview', async c => {
  const { editing, ...input } = categoryRuleInputSchema.extend({
    editing: z.object({ id: textId, version: versionSchema.shape.version }).optional(),
  }).parse(await c.req.json());
  return c.json({ data: await previewCategoryRuleDraft(c.env.DB, input, editing) });
});
categoryRuleRoutes.post('/category-rules/apply', async c => {
  const { snapshot } = z.object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await c.req.json());
  return c.json({ data: await applyCategories(c.env.DB, snapshot) });
});
categoryRuleRoutes.post('/category-rules', async c => c.json({ data: await createCategoryRule(c.env.DB, categoryRuleInputSchema.parse(await c.req.json())) }, 201));
categoryRuleRoutes.patch('/category-rules/:id', async c => {
  const { version, ...input } = categoryRuleInputSchema.extend({ version: versionSchema.shape.version }).parse(await c.req.json());
  return c.json({ data: await updateCategoryRule(c.env.DB, c.req.param('id'), input, version) });
});
categoryRuleRoutes.delete('/category-rules/:id', async c => {
  const { version } = versionSchema.parse(await c.req.json());
  return c.json({ data: await deleteCategoryRule(c.env.DB, c.req.param('id'), version) });
});
