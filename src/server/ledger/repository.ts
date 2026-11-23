import { getTransactionCashflowKind, type ReviewStatus, type SourceDetails, type Transaction, type TransferDirection } from '../../shared/contracts';
import { ApiError, invalid } from '../errors';
import { hashPayload, isExplicitWechatTransfer, type NormalizedInput } from './domain';
import { listCategoryRules, matchCategory } from './classification';
import { rethrowCategoryReferenceError } from './categories';

export interface TransactionRow {
  id: string; occurred_at: string; kind: Transaction['kind']; amount_cents: number; currency: 'CNY';
  description: string; counterparty: string; category_id: string | null; account_id: string;
  source: Transaction['source']; fingerprint: string | null; source_details: string | null; review_status: ReviewStatus; note: string;
  created_at: string; updated_at: string; deleted_at: string | null; version: number;
  is_fixed: number; fixed_auto_excluded: number; transfer_direction: TransferDirection | null;
  category_source: Transaction['categorySource']; category_rule_id: string | null; category_rule_keyword: string | null;
  idempotency_scope: string | null; idempotency_key: string | null; payload_hash: string | null;
}

export function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id, occurredAt: row.occurred_at, kind: row.kind, amountCents: row.amount_cents,
    currency: row.currency, description: row.description, counterparty: row.counterparty,
    categoryId: row.category_id, accountId: row.account_id, source: row.source,
    fingerprint: row.fingerprint, sourceDetails: row.source_details === null ? null : JSON.parse(row.source_details) as SourceDetails,
    reviewStatus: row.review_status, note: row.note, isFixed: row.is_fixed === 1,
    transferDirection: row.kind === 'transfer' ? row.transfer_direction ?? null : null,
    categorySource: row.category_source, categoryRuleId: row.category_rule_id, categoryRuleKeyword: row.category_rule_keyword,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, version: row.version,
  };
}

export async function validateReferences(db: D1Database, input: NormalizedInput): Promise<void> {
  const account = await db.prepare('SELECT id, archived FROM accounts WHERE id = ?').bind(input.accountId).first<{ id: string; archived: number }>();
  if (!account || account.archived) invalid('账户不存在或已停用');
  if (input.categoryId) {
    const category = await db.prepare('SELECT kind FROM categories WHERE id = ?').bind(input.categoryId).first<{ kind: string }>();
    if (!category) invalid('分类不存在');
    const flowKind = getTransactionCashflowKind({ kind: input.kind, transferDirection: input.transferDirection ?? null });
    const categoryKind = flowKind === 'refund' ? 'expense' : flowKind;
    if (category.kind !== 'both' && category.kind !== categoryKind) invalid('分类与交易类型不匹配');
  }
}

export async function getTransaction(db: D1Database, id: string): Promise<TransactionRow> {
  const row = await db.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first<TransactionRow>();
  if (!row) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '账目不存在');
  return row;
}

export async function createTransaction(db: D1Database, input: NormalizedInput, options: {
  key: string; scope: string; source: 'manual' | 'shortcut' | 'import'; fingerprint?: string; needsReview?: boolean; sourceDetails?: SourceDetails;
}): Promise<{ transaction: Transaction; duplicate: boolean }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fingerprint = options.fingerprint || null;
  const sourceDetails = options.sourceDetails || null;
  // A false/omitted flag retains the pre-feature receipt hash for existing clients.
  const { isFixed, categoryOverride, ...ledgerInput } = input;
  const payloadHash = await hashPayload({ ...ledgerInput, ...(isFixed ? { isFixed: true } : {}),
    ...(categoryOverride ? { categoryOverride: true } : {}), source: options.source, fingerprint, sourceDetails });
  const existing = await db.prepare('SELECT * FROM transactions WHERE idempotency_scope = ? AND idempotency_key = ?')
    .bind(options.scope, options.key).first<TransactionRow>();
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一个请求标识已用于不同账目，请核对后重新提交');
    return { transaction: toTransaction(existing), duplicate: true };
  }
  // Derive the ledger type after recording the original request identity. Older
  // phone parsers call a received WeChat transfer a refund; retries must still
  // match their original payload, including after a historical correction.
  const explicitWechatTransfer = (options.source === 'shortcut' || options.source === 'import') && isExplicitWechatTransfer(input.description, sourceDetails);
  const kind = explicitWechatTransfer ? 'transfer' : input.kind;
  const transferDirection = kind === 'transfer' ? input.transferDirection ?? sourceDetails?.direction ?? null : null;
  if (kind === 'transfer' && !transferDirection) invalid('请选择转入或转出，再保存转账。');
  await validateReferences(db, { ...input, kind, ...(transferDirection ? { transferDirection } : {}) });
  const note = explicitWechatTransfer && input.note === '其他入账，请确认是否属于收入。' ? '' : input.note;
  let categoryId = input.categoryId;
  let categorySource: Transaction['categorySource'] = categoryId || categoryOverride ? 'manual' : 'unclassified';
  let categoryRuleId: string | null = null, categoryRuleKeyword: string | null = null;
  if (categorySource === 'unclassified') {
    const match = matchCategory({ ...input, kind, transferDirection }, await listCategoryRules(db));
    if (match.status === 'matched') {
      categoryId = match.rule.categoryId; categorySource = 'rule'; categoryRuleId = match.rule.id; categoryRuleKeyword = match.rule.keyword;
    }
  }
  // SQLite serializes each statement. The uniqueness constraint and collision lookup belong to this
  // one INSERT so concurrent delivery cannot both create a confirmed transaction or claim the key.
  try {
    await db.prepare(`INSERT INTO transactions (
    id, occurred_at, kind, amount_cents, currency, description, counterparty, category_id,
    account_id, source, fingerprint, source_details, review_status, note, created_at, updated_at, version,
    idempotency_scope, idempotency_key, payload_hash, is_fixed, category_source, category_rule_id, category_rule_keyword, transfer_direction
  ) VALUES (?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, ?,
    CASE WHEN ? = 1 OR (? IS NOT NULL AND EXISTS (
      SELECT 1 FROM transactions WHERE account_id = ? AND fingerprint = ? AND deleted_at IS NULL
    )) THEN 'pending' ELSE 'confirmed' END,
    ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (idempotency_scope, idempotency_key) DO NOTHING`)
    .bind(id, input.occurredAt, kind, input.amountCents, input.description, input.counterparty,
      categoryId, input.accountId, options.source, fingerprint, sourceDetails ? JSON.stringify(sourceDetails) : null,
      options.needsReview && !explicitWechatTransfer ? 1 : 0, fingerprint, input.accountId, fingerprint,
      note, now, now, options.scope, options.key, payloadHash, isFixed ? 1 : 0, categorySource, categoryRuleId, categoryRuleKeyword, transferDirection).run();
  } catch (error) { rethrowCategoryReferenceError(error); }
  const row = await db.prepare('SELECT * FROM transactions WHERE idempotency_scope = ? AND idempotency_key = ?')
    .bind(options.scope, options.key).first<TransactionRow>();
  if (!row) throw new ApiError(500, 'WRITE_FAILED', '账目保存未完成，请使用同一个请求标识重试');
  if (row.payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '同一个请求标识已用于不同账目，请核对后重新提交');
  await syncFixedExpenses(db);
  const finalRow = await db.prepare('SELECT * FROM transactions WHERE id = ?').bind(row.id).first<TransactionRow>() ?? row;
  return { transaction: toTransaction(finalRow), duplicate: row.id !== id };
}

export async function updateTransaction(db: D1Database, id: string, input: NormalizedInput, version: number, status?: ReviewStatus): Promise<Transaction> {
  const previous = await getTransaction(db, id);
  const sourceDirection = previous.source_details === null ? null : (JSON.parse(previous.source_details) as SourceDetails).direction;
  const transferDirection = input.kind === 'transfer' ? input.transferDirection ?? previous.transfer_direction ?? sourceDirection ?? null : null;
  if (input.kind === 'transfer' && !transferDirection) invalid('请选择转入或转出，再保存转账。');
  await validateReferences(db, { ...input, ...(transferDirection ? { transferDirection } : {}) });
  // Changing transaction kind is a manual decision outside the original rule's scope.
  const categoryChanged = input.categoryOverride || input.categoryId !== previous.category_id || input.kind !== previous.kind || transferDirection !== previous.transfer_direction;
  const fixed = input.isFixed === undefined ? null : Number(input.isFixed);
  const now = new Date().toISOString();
  let row: TransactionRow | null;
  try {
    const edit = db.prepare(`UPDATE transactions SET occurred_at = ?, kind = ?, amount_cents = ?,
    description = ?, counterparty = ?, category_id = ?, account_id = ?, note = ?,
    review_status = COALESCE(?, review_status), updated_at = ?, version = version + 1,
    is_fixed = CASE WHEN ? != 'expense' THEN 0 ELSE COALESCE(?, is_fixed) END,
    fixed_auto_excluded = CASE WHEN ? = 1 THEN 0 WHEN (? = 0 OR ? != 'expense') AND is_fixed = 1 THEN 1 ELSE fixed_auto_excluded END,
    category_source = ?, category_rule_id = ?, category_rule_keyword = ?, transfer_direction = ?
    WHERE id = ? AND version = ? AND deleted_at IS NULL RETURNING *`)
    .bind(input.occurredAt, input.kind, input.amountCents, input.description, input.counterparty,
      input.categoryId, input.accountId, input.note, status || null, now,
      input.kind, fixed, fixed, fixed, input.kind,
      categoryChanged ? 'manual' : previous.category_source, categoryChanged ? null : previous.category_rule_id,
      categoryChanged ? null : previous.category_rule_keyword, transferDirection, id, version);
    const updatePeers = previous.is_fixed && fixed !== 0 && input.kind === 'expense' &&
      previous.review_status === 'confirmed' && status !== 'pending' && previous.account_id === input.accountId &&
      previous.amount_cents === input.amountCents && (previous.description !== input.description || previous.category_id !== input.categoryId);
    if (updatePeers) {
      // Only propagate an explicit edit to confirmed fixed entries with the same
      // original merchant details and category. A shared collection platform alone is ambiguous.
      const peers = db.prepare(`UPDATE transactions SET description=?1,category_id=?2,
          category_source=CASE WHEN category_id IS ?2 THEN category_source ELSE 'manual' END,
          category_rule_id=CASE WHEN category_id IS ?2 THEN category_rule_id ELSE NULL END,
          category_rule_keyword=CASE WHEN category_id IS ?2 THEN category_rule_keyword ELSE NULL END,
          updated_at=?3,version=version+1
        WHERE id!=?4 AND deleted_at IS NULL AND review_status='confirmed' AND kind='expense' AND is_fixed=1
          AND account_id=?5 AND amount_cents=?6 AND description=?7 AND counterparty=?8 AND category_id IS ?9
          AND EXISTS(SELECT 1 FROM transactions WHERE id=?4 AND version=?10 AND deleted_at IS NULL)`)
        .bind(input.description, input.categoryId, now, id, previous.account_id, previous.amount_cents,
          previous.description, previous.counterparty, previous.category_id, version);
      const results = await db.batch<TransactionRow>([peers, edit]);
      row = results[1].results[0] ?? null;
    } else {
      row = await edit.first<TransactionRow>();
    }
  } catch (error) { rethrowCategoryReferenceError(error); }
  if (!row) await explainWriteConflict(db, id);
  if (row!.review_status === 'confirmed') {
    await syncFixedExpenses(db);
    return toTransaction(await getTransaction(db, id));
  }
  return toTransaction(row!);
}

export async function changeStatus(db: D1Database, id: string, version: number, operation: 'archive' | 'restore' | 'confirm'): Promise<Transaction> {
  const now = new Date().toISOString();
  const assignment = operation === 'archive' ? 'deleted_at = ?' : operation === 'restore' ? 'deleted_at = NULL' : "review_status = 'confirmed'";
  const condition = operation === 'restore' ? 'deleted_at IS NOT NULL' : operation === 'confirm' ? "deleted_at IS NULL AND review_status = 'pending'" : 'deleted_at IS NULL';
  const values = operation === 'archive' ? [now, now, id, version] : [now, id, version];
  const row = await db.prepare(`UPDATE transactions SET ${assignment}, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND ${condition} RETURNING *`)
    .bind(...values).first<TransactionRow>();
  if (!row) await explainWriteConflict(db, id);
  if (operation !== 'archive' && row!.review_status === 'confirmed') {
    await syncFixedExpenses(db);
    return toTransaction(await getTransaction(db, id));
  }
  return toTransaction(row!);
}

async function explainWriteConflict(db: D1Database, id: string): Promise<never> {
  await getTransaction(db, id);
  throw new ApiError(409, 'VERSION_CONFLICT', '账目已发生变化，请刷新后再操作');
}

const CHANNEL_PREFIX_RE = /^(?:(?:支付宝|财付通|微信支付|美团|美团App|拼多多支付)\s*[-－]\s*)+(?:消费\s*[-－]\s*)?/iu;
const TRUNCATED_SUFFIX_RE = /(?:\.{3,}|…+)$/u;

function normalizeAlias(value: string): string {
  return value.normalize('NFKC').replace(/[－—–]/gu, '-').replace(/\s+/gu, ' ').trim();
}

function coreMerchantStem(value: string): { stem: string; truncated: boolean } | null {
  const norm = normalizeAlias(value);
  if (!norm) return null;
  const truncated = TRUNCATED_SUFFIX_RE.test(norm);
  const stripped = norm.replace(TRUNCATED_SUFFIX_RE, '').replace(CHANNEL_PREFIX_RE, '').trim();
  if (stripped.length < 4 || /^(?:微信转账|扫二维码付款|消费|转账|其他)$/u.test(stripped)) return null;
  return { stem: stripped.toLowerCase(), truncated };
}

function matchesFixedAliases(
  candidateNames: readonly string[],
  templateAliases: ReadonlySet<string>,
  templateStems: readonly { stem: string; truncated: boolean }[],
): boolean {
  for (const raw of candidateNames) {
    const norm = normalizeAlias(raw);
    if (!norm) continue;
    if (templateAliases.has(norm.toLowerCase())) return true;
    const cand = coreMerchantStem(norm);
    if (!cand) continue;
    for (const tpl of templateStems) {
      if (cand.stem === tpl.stem) return true;
      if (cand.truncated && tpl.stem.startsWith(cand.stem)) return true;
      if (tpl.truncated && cand.stem.startsWith(tpl.stem)) return true;
    }
  }
  return false;
}

/**
 * 固定支出跨月自动识别：
 * 以已确认的固定支出（is_fixed = 1）为模板，结合其现用名、counterparty 与审计表中的曾用名，
 * 自动将同账户下金额完全相同（amount_cents 相等）且名称/曾用名匹配的跨月支出（或微信转账转出）
 * 标记为固定支出，并同步名称与分类。
 */
export async function syncFixedExpenses(db: D1Database): Promise<number> {
  const fixedRes = await db.prepare(`
    SELECT t.account_id, t.amount_cents, t.description, t.counterparty, t.category_id,
           (SELECT group_concat(json_extract(a.snapshot, '$.description'), char(31))
            FROM transaction_audit a WHERE a.transaction_id = t.id) AS audit_descriptions,
           (SELECT group_concat(json_extract(a.snapshot, '$.counterparty'), char(31))
            FROM transaction_audit a WHERE a.transaction_id = t.id) AS audit_counterparties
    FROM transactions t
    WHERE t.is_fixed = 1 AND t.kind = 'expense' AND t.deleted_at IS NULL AND t.review_status = 'confirmed'
  `).all<{
    account_id: string; amount_cents: number; description: string; counterparty: string;
    category_id: string | null; audit_descriptions: string | null; audit_counterparties: string | null;
  }>();

  const fixedRows = fixedRes.results ?? [];
  if (!fixedRows.length) return 0;

  interface FixedGroup {
    template: typeof fixedRows[number];
    aliases: Set<string>;
    stems: { stem: string; truncated: boolean }[];
  }

  const groups = new Map<string, FixedGroup[]>();
  for (const row of fixedRows) {
    const key = `${row.account_id}:${row.amount_cents}`;
    const bucket = groups.get(key) ?? [];
    const group: FixedGroup = { template: row, aliases: new Set(), stems: [] };
    bucket.push(group);
    groups.set(key, bucket);
    const rawNames = [
      row.description,
      row.counterparty,
      ...(row.audit_descriptions ? row.audit_descriptions.split('\u001f') : []),
      ...(row.audit_counterparties ? row.audit_counterparties.split('\u001f') : []),
    ];
    for (const raw of rawNames) {
      if (!raw) continue;
      const norm = normalizeAlias(raw);
      if (!norm) continue;
      group.aliases.add(norm.toLowerCase());
      const stem = coreMerchantStem(norm);
      if (stem && !group.stems.some(s => s.stem === stem.stem && s.truncated === stem.truncated)) {
        group.stems.push(stem);
      }
    }
  }

  const candidatesRes = await db.prepare(`
    SELECT t.id, t.account_id, t.amount_cents, t.description, t.counterparty,
           t.category_id, t.category_source, t.version,
           (SELECT group_concat(json_extract(a.snapshot, '$.description'), char(31))
            FROM transaction_audit a WHERE a.transaction_id = t.id) AS audit_descriptions
    FROM transactions t
    WHERE t.deleted_at IS NULL AND t.review_status = 'confirmed'
      AND (t.kind = 'expense' OR (t.kind = 'transfer' AND t.transfer_direction = 'outflow'))
      AND t.fixed_auto_excluded = 0 AND t.is_fixed = 0
      AND (t.account_id, t.amount_cents) IN (
        SELECT account_id, amount_cents FROM transactions
        WHERE is_fixed = 1 AND kind = 'expense' AND deleted_at IS NULL AND review_status = 'confirmed'
      )
  `).all<{
    id: string; account_id: string;
    amount_cents: number; description: string; counterparty: string; category_id: string | null;
    category_source: Transaction['categorySource']; version: number; audit_descriptions: string | null;
  }>();

  let updatedCount = 0;
  const now = new Date().toISOString();
  for (const cand of candidatesRes.results ?? []) {
    const templates = groups.get(`${cand.account_id}:${cand.amount_cents}`) ?? [];
    const candidateNames = [
      cand.description,
      cand.counterparty,
      ...(cand.audit_descriptions ? cand.audit_descriptions.split('\u001f') : []),
    ].filter(Boolean);
    const matches = templates.filter(group => matchesFixedAliases(candidateNames, group.aliases, group.stems));
    const tpl = matches[0]?.template;
    if (!tpl || matches.some(({ template }) => template.description !== tpl.description || template.category_id !== tpl.category_id)) continue;
    const nextDescription = tpl.description;
    const nextCounterparty = cand.counterparty || (cand.description !== tpl.description ? cand.description : '');
    const nextCategoryId = cand.category_source === 'manual' ? cand.category_id : (tpl.category_id ?? cand.category_id);
    const nextCategorySource: Transaction['categorySource'] = nextCategoryId !== cand.category_id
      ? 'manual'
      : (cand.category_source === 'unclassified' && nextCategoryId ? 'manual' : cand.category_source);

    const updated = await db.prepare(`
      UPDATE transactions
      SET kind = 'expense',
          transfer_direction = NULL,
          is_fixed = 1,
          description = ?,
          counterparty = ?,
          category_id = ?,
          category_source = ?,
          category_rule_id = CASE WHEN ? != COALESCE(category_id, '') THEN NULL ELSE category_rule_id END,
          category_rule_keyword = CASE WHEN ? != COALESCE(category_id, '') THEN NULL ELSE category_rule_keyword END,
          updated_at = ?,
          version = version + 1
      WHERE id = ? AND version = ? AND deleted_at IS NULL AND fixed_auto_excluded = 0
    `).bind(
      nextDescription,
      nextCounterparty,
      nextCategoryId,
      nextCategorySource,
      nextCategoryId ?? '',
      nextCategoryId ?? '',
      now,
      cand.id,
      cand.version,
    ).run();
    updatedCount += updated.meta.changes ?? 0;
  }

  return updatedCount;
}
