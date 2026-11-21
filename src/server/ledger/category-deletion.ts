import { Hono } from 'hono';
import { z } from 'zod';
import { getTransactionCashflowKind, type CategoryDeletionPreview, type CategoryDeletionResult, type CategoryRule } from '../../shared/contracts';
import type { ApiEnv } from '../types';
import { ApiError, invalid } from '../errors';
import { hashPayload, textId } from './domain';
import { readClassificationState, classificationPlan, categoryUpdateStatements, effectiveRules, toCategoryRule,
  type ClassificationState, type CategoryRuleRow } from './classification';

function conflict(): never {
  throw new ApiError(409, 'CATEGORY_VERSION_CONFLICT', '类目或关联的账单、规则已变化，请重新查看删除影响。');
}

const tagCountsSql = `SELECT
  (SELECT COUNT(*) FROM tags WHERE category_id=?1) AS tagCount,
  (SELECT COUNT(*) FROM tag_rules JOIN tags ON tags.id=tag_rules.tag_id WHERE tags.category_id=?1) AS tagRuleCount`;

async function deletionState(db: D1Database, id: string, replacementCategoryId?: string) {
  const state = await readClassificationState(db, { allTransactions: true });
  const category = state.categories.find(item => item.id === id);
  if (!category) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '类目不存在。');
  const references = state.transactions.filter(row => row.category_id === id);
  // Persisted overrides take precedence over implicit built-ins, including disabled overrides.
  const rules = [
    ...state.ruleRows.filter(row => row.category_id === id).map(toCategoryRule),
    ...effectiveRules(state.ruleRows, state.categories).filter(rule => rule.source === 'builtin' && rule.categoryId === id),
  ];
  const requiredKinds = new Set([...references.map(row => {
    const flow = getTransactionCashflowKind(row);
    return flow === 'refund' ? 'expense' : flow;
  }), ...rules.map(rule => rule.kind)]);
  const candidates = references.length || rules.length ? state.categories.filter(candidate => candidate.id !== id &&
    [...requiredKinds].every(kind => candidate.kind === 'both' || candidate.kind === kind)) : [];
  const tagCounts = (await db.prepare(tagCountsSql).bind(id).first<{ tagCount: number; tagRuleCount: number }>())!;
  const snapshot = await hashPayload({ categoryId: id, revision: state.revision, replacementCategoryId: replacementCategoryId ?? null, ...tagCounts });
  return { state, category, references, rules, candidates, snapshot, ...tagCounts };
}

function migratedRules(state: ClassificationState, rules: CategoryRule[], replacementId: string): CategoryRuleRow[] {
  const movedIds = new Set(rules.map(rule => rule.id));
  return [...state.ruleRows.filter(row => !movedIds.has(row.id)), ...rules.map(rule => ({
    id: rule.id, keyword: rule.keyword, match_type: rule.matchType, kind: rule.kind,
    category_id: replacementId, enabled: rule.enabled ? 1 : 0, version: rule.version + 1,
  }))];
}

async function migrationPlan(context: Awaited<ReturnType<typeof deletionState>>, replacementId: string) {
  const { state, category, rules } = context;
  const nextRules = migratedRules(state, rules, replacementId);
  // Choosing the target explicitly classifies every directly referenced transaction.
  // Other automatic transactions still reconcile against the final effective rules.
  const plan = rules.length ? await classificationPlan({ ...state, ruleRows: nextRules,
    categories: state.categories.filter(item => item.id !== category.id),
    transactions: state.transactions.filter(row => row.category_id !== category.id),
  }) : null;
  return { nextRules, items: plan?.items ?? [] };
}

export async function previewCategoryDeletion(db: D1Database, id: string, replacementCategoryId?: string): Promise<CategoryDeletionPreview> {
  const context = await deletionState(db, id, replacementCategoryId);
  const replacements: CategoryDeletionPreview['replacements'] = [];
  if (replacementCategoryId) {
    if (!context.candidates.some(candidate => candidate.id === replacementCategoryId)) invalid('请选择与所有关联账单和规则兼容的其他类目。');
    const plan = await migrationPlan(context, replacementCategoryId);
    replacements.push({ categoryId: replacementCategoryId, updatedTransactions: context.references.length + plan.items.length });
  }
  return { category: context.category, transactionCount: context.references.length,
    archivedTransactionCount: context.references.filter(row => row.deleted_at !== null).length,
    tagCount: context.tagCount, tagRuleCount: context.tagRuleCount,
    ruleCount: context.rules.length, candidates: context.candidates, replacementCategoryId: replacementCategoryId ?? null,
    replacements, snapshot: context.snapshot };
}

export async function deleteCategory(db: D1Database, id: string, snapshot: string, replacementCategoryId?: string): Promise<CategoryDeletionResult> {
  const context = await deletionState(db, id, replacementCategoryId);
  if (snapshot !== context.snapshot) conflict();
  const used = context.references.length > 0 || context.rules.length > 0;
  if (used && !replacementCategoryId) invalid('此类目已被账单或规则使用，请选择接收它们的类目。');
  if (replacementCategoryId && !context.candidates.some(candidate => candidate.id === replacementCategoryId)) {
    invalid('请选择与所有关联账单和规则兼容的其他类目。');
  }
  const plan = replacementCategoryId ? await migrationPlan(context, replacementCategoryId) : { nextRules: context.state.ruleRows, items: [] };
  const guardId = `category-delete:${crypto.randomUUID()}`;
  const statements = [db.prepare(`INSERT INTO restore_guards(id,valid)
    SELECT ?2, CASE WHEN (SELECT revision FROM classification_state WHERE id=1)=?3
      AND tagCount=?4 AND tagRuleCount=?5 THEN 1 ELSE 0 END FROM (${tagCountsSql})`)
    .bind(id, guardId, context.state.revision, context.tagCount, context.tagRuleCount)];
  if (replacementCategoryId) {
    const movedIds = new Set(context.rules.map(rule => rule.id));
    for (const rule of plan.nextRules.filter(row => movedIds.has(row.id))) {
      statements.push(db.prepare(`INSERT INTO category_rules(id,keyword,match_type,kind,category_id,enabled,version)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,version=excluded.version`)
        .bind(rule.id, rule.keyword, rule.match_type, rule.kind, rule.category_id, rule.enabled, rule.version));
    }
    statements.push(db.prepare(`UPDATE transactions SET category_id=?,category_source='manual',category_rule_id=NULL,
      category_rule_keyword=NULL,updated_at=?,version=version+1 WHERE category_id=?`)
      .bind(replacementCategoryId, new Date().toISOString(), id));
    statements.push(...categoryUpdateStatements(db, plan.items));
  }

  const deleteIndex = statements.length;
  statements.push(db.prepare('DELETE FROM categories WHERE id=? AND version=? RETURNING id').bind(id, context.category.version));
  statements.push(db.prepare('DELETE FROM restore_guards WHERE id=?').bind(guardId));
  try {
    const results = await db.batch(statements);
    if (!results[deleteIndex].results.length) conflict();
    return { deleted: true, movedTransactions: context.references.length, movedRules: context.rules.length,
      updatedTransactions: context.references.length + plan.items.length };
  } catch (error) {
    if (error instanceof Error && /constraint/i.test(error.message)) conflict();
    throw error;
  }
}

export const categoryDeletionRoutes = new Hono<ApiEnv>();
categoryDeletionRoutes.get('/categories/:id/deletion-preview', async c => {
  const replacementCategoryId = textId.optional().parse(c.req.query('replacementCategoryId'));
  return c.json({ data: await previewCategoryDeletion(c.env.DB, c.req.param('id'), replacementCategoryId) });
});
categoryDeletionRoutes.delete('/categories/:id', async c => {
  const { snapshot, replacementCategoryId } = z.object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), replacementCategoryId: textId.optional() }).parse(await c.req.json());
  return c.json({ data: await deleteCategory(c.env.DB, c.req.param('id'), snapshot, replacementCategoryId) });
});
