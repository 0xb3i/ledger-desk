import type { FeishuIssueDetail, SourceDetails, TransactionKind } from '../shared/contracts';
import { getTransactionCashflowKind, KIND_LABELS } from '../shared/contracts';
import { ApiError } from '../server/errors';
import { hashPayload, isExplicitWechatTransfer, parseCmb, type NormalizedInput } from '../server/ledger/domain';
import { toTransaction, validateReferences, type TransactionRow } from '../server/ledger/repository';
import { digest } from '../server/security';

export type FeishuSource = ReturnType<typeof parseCmb>;
interface Checkpoint {
  source_hash: string; source_snapshot: string | null; pending_snapshot: string | null; transaction_id: string;
}
interface Context { db: D1Database; sourceId: string; recordId: string; checkpoint: Checkpoint; row: TransactionRow; revision: number }
type Patch = Partial<Pick<TransactionRow, 'description' | 'counterparty' | 'occurred_at' | 'amount_cents' | 'kind' | 'transfer_direction' | 'source_details' | 'category_source' | 'category_rule_id' | 'category_rule_keyword'>>;
const labels = {
  amount: '金额', time: '交易时间', type: '来源交易类型', direction: '资金方向', balance: '交易后余额',
  account: '资金账户', fingerprint: '交易指纹', description: '交易摘要', counterparty: '交易主体',
  parserVersion: '解析版本', timeRaw: '原交易时间',
} as const;
type Field = keyof typeof labels;
const metadata: Field[] = ['description', 'counterparty', 'parserVersion', 'timeRaw'];
const fields = Object.keys(labels) as Field[];
const typeLabels: Record<string, string> = { purchase: '消费', refund: '退款', transfer_out: '转出', transfer_in: '转入', salary: '工资', credit: '其他入账', wallet_withdrawal: '提现转入', wallet_topup: '充值转出' };
function stale(): never { throw new ApiError(409, 'FEISHU_ISSUE_STALE', '账单或飞书同步内容已变化，请重新查看差异。'); }
function canonicalBalance(value?: string): string {
  if (value === undefined) return '';
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return `${negative && cents ? '-' : ''}${cents}`;
}
function sourceValues(source: FeishuSource): Record<Field, string> {
  return { amount: String(source.transaction.amountCents), time: source.transaction.occurredAt,
    type: source.sourceDetails.transactionType, direction: source.sourceDetails.direction,
    balance: canonicalBalance(source.sourceDetails.balance), account: source.transaction.accountId, fingerprint: source.fingerprint,
    description: source.transaction.description, counterparty: source.transaction.counterparty,
    parserVersion: source.sourceDetails.parserVersion, timeRaw: source.sourceDetails.transactionTimeRaw ?? '' };
}
function localValues(row: TransactionRow): Record<Field, string> {
  const details = row.source_details ? JSON.parse(row.source_details) as SourceDetails : null;
  return { amount: String(row.amount_cents), time: row.occurred_at, type: details?.transactionType ?? row.kind,
    direction: details?.direction ?? (getTransactionCashflowKind(toTransaction(row)) === 'expense' ? 'outflow' : 'inflow'),
    balance: canonicalBalance(details?.balance), account: row.account_id, fingerprint: row.fingerprint ?? '',
    description: row.description, counterparty: row.counterparty, parserVersion: details?.parserVersion ?? '', timeRaw: details?.transactionTimeRaw ?? '' };
}
function changesFrom(baseline: FeishuSource | null, remote: FeishuSource): Field[] {
  if (!baseline) return fields;
  const before = sourceValues(baseline), after = sourceValues(remote);
  return fields.filter(field => before[field] !== after[field]);
}
async function readContext(db: D1Database, sourceId: string, recordId: string): Promise<Context | null> {
  const [checkpoints, transactions, revision] = await db.batch([
    db.prepare('SELECT * FROM local_feishu_records WHERE source_id=? AND record_id=?').bind(sourceId, recordId),
    db.prepare('SELECT t.* FROM transactions t JOIN local_feishu_records f ON f.transaction_id=t.id WHERE f.source_id=? AND f.record_id=?').bind(sourceId, recordId),
    db.prepare('SELECT revision FROM classification_state WHERE id=1'),
  ]);
  const checkpoint = checkpoints.results[0] as unknown as Checkpoint | undefined;
  const row = transactions.results[0] as unknown as TransactionRow | undefined;
  return checkpoint && row ? { db, sourceId, recordId, checkpoint, row, revision: (revision.results[0] as { revision: number }).revision } : null;
}
async function verifiedSnapshot(raw: string | null, hash: string): Promise<FeishuSource | null> {
  if (!raw) return null;
  try { const parsed = JSON.parse(raw) as FeishuSource; return await digest(JSON.stringify(parsed)) === hash ? parsed : null; }
  catch { return null; }
}
/** Legacy rows have only a hash. Reconstruct from immutable creation audit, never today's editable transaction. */
async function recoverBaseline(context: Context): Promise<FeishuSource | null> {
  const stored = await verifiedSnapshot(context.checkpoint.source_snapshot, context.checkpoint.source_hash);
  if (stored) return stored;
  const audit = await context.db.prepare("SELECT snapshot FROM transaction_audit WHERE transaction_id=? AND action='created' ORDER BY version LIMIT 1")
    .bind(context.row.id).first<{ snapshot: string }>();
  if (!audit) return null;
  try {
    const original = JSON.parse(audit.snapshot) as ReturnType<typeof toTransaction>;
    if (!original.sourceDetails || !original.fingerprint) return null;
    const details = original.sourceDetails;
    const parsed = parseCmb({ amount: `${Math.floor(original.amountCents / 100)}.${String(original.amountCents % 100).padStart(2, '0')}`,
      transaction_time: original.occurredAt, transaction_type: details.transactionType, direction: details.direction,
      description: original.description, counterparty: original.counterparty, bank: '招商银行', currency: 'CNY',
      parser_version: details.parserVersion, transaction_fingerprint: original.fingerprint,
      ...(details.balance === undefined ? {} : { balance: details.balance }),
      ...(details.transactionTimeRaw === undefined ? {} : { transaction_time_raw: details.transactionTimeRaw }),
    }, original.accountId);
    const candidates = [parsed, { ...parsed, transaction: { ...parsed.transaction, kind: original.kind, note: original.note }, needsReview: original.reviewStatus === 'pending' }];
    // Before explicit wallet-withdrawal recognition, credit used the generic income/review representation.
    if (details.transactionType === 'credit') candidates.push({ ...parsed,
      transaction: { ...parsed.transaction, kind: 'income', note: '其他入账，请确认是否属于收入。' }, needsReview: true });
    for (const candidate of candidates) if (await digest(JSON.stringify(candidate)) === context.checkpoint.source_hash) return candidate;
  } catch { /* An unprovable baseline is a visible conflict, not a guessed merge. */ }
  return null;
}
function mergeMetadata(row: TransactionRow, baseline: FeishuSource, remote: FeishuSource): Patch {
  const before = sourceValues(baseline), incoming = sourceValues(remote), local = localValues(row);
  return sourcePatch(row, remote, metadata.filter(field => before[field] !== incoming[field] && local[field] === before[field]));
}
function sourcePatch(row: TransactionRow, remote: FeishuSource, changed: Field[]): Patch {
  const patch: Patch = {}, has = (field: Field) => changed.includes(field);
  if (has('description')) patch.description = remote.transaction.description;
  if (has('counterparty')) patch.counterparty = remote.transaction.counterparty;
  if (has('amount')) patch.amount_cents = remote.transaction.amountCents;
  if (has('time')) patch.occurred_at = remote.transaction.occurredAt;
  if (has('type') || has('direction')) {
    const kind: TransactionKind = isExplicitWechatTransfer(remote.transaction.description, remote.sourceDetails) ? 'transfer' : remote.transaction.kind;
    const direction = kind === 'transfer' ? remote.sourceDetails.direction : null;
    patch.kind = kind; patch.transfer_direction = direction;
    // Match the existing manual-edit contract when the user explicitly changes financial type.
    if (kind !== row.kind || direction !== row.transfer_direction) {
      patch.category_source = 'manual'; patch.category_rule_id = null; patch.category_rule_keyword = null;
    }
  }
  if (changed.some(field => ['type', 'direction', 'balance', 'parserVersion', 'timeRaw'].includes(field))) {
    const details = row.source_details ? JSON.parse(row.source_details) as SourceDetails : { ...remote.sourceDetails };
    if (has('type')) details.transactionType = remote.sourceDetails.transactionType;
    if (has('direction')) details.direction = remote.sourceDetails.direction;
    if (has('parserVersion')) details.parserVersion = remote.sourceDetails.parserVersion;
    if (has('balance')) { if (remote.sourceDetails.balance === undefined) delete details.balance; else details.balance = remote.sourceDetails.balance; }
    if (has('timeRaw')) { if (remote.sourceDetails.transactionTimeRaw === undefined) delete details.transactionTimeRaw; else details.transactionTimeRaw = remote.sourceDetails.transactionTimeRaw; }
    patch.source_details = JSON.stringify(details);
  }
  for (const key of Object.keys(patch) as (keyof Patch)[]) if (patch[key] === row[key]) delete patch[key];
  return patch;
}
async function commit(context: Context, baseline: FeishuSource | null, sourceHash: string, pending: FeishuSource | null, patch: Patch = {}, extra: D1PreparedStatement[] = []) {
  const { db, checkpoint, row, sourceId, recordId, revision } = context;
  const guardId = `feishu-reconcile:${crypto.randomUUID()}`;
  const statements = [db.prepare(`INSERT INTO restore_guards(id,valid) VALUES(?,CASE WHEN
    (SELECT revision FROM classification_state WHERE id=1)=? AND EXISTS(
      SELECT 1 FROM local_feishu_records f JOIN transactions t ON t.id=f.transaction_id
      WHERE f.source_id=? AND f.record_id=? AND f.source_hash=? AND f.source_snapshot IS ? AND f.pending_snapshot IS ? AND t.version=?
    ) THEN 1 ELSE 0 END)`).bind(guardId, revision, sourceId, recordId, checkpoint.source_hash, checkpoint.source_snapshot, checkpoint.pending_snapshot, row.version)];
  const entries = Object.entries(patch);
  if (entries.length) statements.push(db.prepare(`UPDATE transactions SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=?,version=version+1 WHERE id=? AND version=?`)
    .bind(...entries.map(([, value]) => value), new Date().toISOString(), row.id, row.version));
  statements.push(db.prepare('UPDATE local_feishu_records SET source_hash=?,source_snapshot=?,pending_snapshot=? WHERE source_id=? AND record_id=?')
    .bind(sourceHash, baseline ? JSON.stringify(baseline) : null, pending ? JSON.stringify(pending) : null, sourceId, recordId));
  statements.push(...extra, db.prepare('DELETE FROM restore_guards WHERE id=?').bind(guardId));
  try { await db.batch(statements); }
  catch (error) { if (error instanceof Error && /constraint/i.test(error.message)) stale(); throw error; }
}

export async function reconcileFeishuRecord(db: D1Database, sourceId: string, recordId: string, remote: FeishuSource, sourceHash: string) {
  const context = await readContext(db, sourceId, recordId);
  if (!context) return null;
  const { checkpoint, row } = context;
  if (checkpoint.source_hash === sourceHash) {
    if (!checkpoint.source_snapshot || checkpoint.pending_snapshot) await commit(context, remote, sourceHash, null);
    return { changed: false, transaction: toTransaction(row) };
  }
  if (row.deleted_at !== null) {
    await commit(context, remote, sourceHash, null);
    return { changed: false, transaction: toTransaction(row) };
  }
  const baseline = await recoverBaseline(context);
  if (baseline && changesFrom(baseline, remote).every(field => metadata.includes(field))) {
    await commit(context, remote, sourceHash, null, mergeMetadata(row, baseline, remote));
    return { changed: false, transaction: toTransaction(row) };
  }
  await commit(context, baseline, checkpoint.source_hash, remote);
  return { changed: true, transaction: toTransaction(row) };
}

function display(field: Field, value: string): string {
  if (value === '') return '—';
  if (field === 'amount' || field === 'balance') {
    const cents = BigInt(value), absolute = cents < 0n ? -cents : cents;
    return `${cents < 0n ? '−' : ''}¥${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }
  if (field === 'type') return typeLabels[value] ?? value;
  if (field === 'direction') return value === 'inflow' ? '流入' : value === 'outflow' ? '流出' : value;
  if (field === 'time') return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
  return value;
}
async function issueContext(db: D1Database, sourceId: string, recordId: string) {
  const context = await readContext(db, sourceId, recordId);
  if (!context?.checkpoint.pending_snapshot) throw new ApiError(404, 'FEISHU_ISSUE_NOT_FOUND', '这条记录已没有待处理的同步变更，请刷新同步状态。');
  const remote = JSON.parse(context.checkpoint.pending_snapshot) as FeishuSource;
  const baseline = await recoverBaseline(context);
  const changed = changesFrom(baseline, remote), patch = sourcePatch(context.row, remote, changed);
  const snapshot = await hashPayload({ sourceId, recordId, sourceHash: context.checkpoint.source_hash,
    pending: context.checkpoint.pending_snapshot, version: context.row.version, revision: context.revision });
  let blocked: string | undefined;
  if (context.row.deleted_at !== null) blocked = '本地账单已删除，不能采用飞书内容。';
  else if (changed.includes('fingerprint') && remote.fingerprint !== context.row.fingerprint) blocked = '交易指纹已变化，请先在飞书确认是否仍为同一笔交易。';
  else if (changed.includes('account') && remote.transaction.accountId !== context.row.account_id) blocked = '资金账户不同，请先在本地账单中调整账户。';
  else if (context.row.is_fixed && (patch.kind ?? context.row.kind) !== 'expense') blocked = '本地账单标记为固定支出，请先编辑账单取消该标记。';
  else {
    const row = { ...context.row, ...patch };
    const input: NormalizedInput = { occurredAt: row.occurred_at, kind: row.kind, amountCents: row.amount_cents,
      description: row.description, counterparty: row.counterparty, categoryId: row.category_id,
      accountId: row.account_id, note: row.note, ...(row.transfer_direction ? { transferDirection: row.transfer_direction } : {}) };
    try { await validateReferences(db, input); }
    catch (error) { if (error instanceof ApiError && error.status === 422) blocked = '本地类目或账户不适用于飞书的新交易类型，请先编辑本地账单。'; else throw error; }
  }
  const local = localValues(context.row), incoming = sourceValues(remote);
  const changes: FeishuIssueDetail['changes'] = changed.map(field => ({ field: String(field), label: labels[field], localValue: display(field, local[field]), remoteValue: display(field, incoming[field]) }));
  const after = { ...context.row, ...patch };
  if (after.kind !== context.row.kind || after.transfer_direction !== context.row.transfer_direction) {
    const kindLabel = (row: TransactionRow) => row.kind === 'transfer'
      ? row.transfer_direction === 'inflow' ? '转入' : row.transfer_direction === 'outflow' ? '转出' : '转账（方向待确认）'
      : KIND_LABELS[row.kind];
    changes.push({ field: 'ledgerKind', label: '账单类型', localValue: kindLabel(context.row), remoteValue: kindLabel(after) });
  }
  const detail: FeishuIssueDetail = { recordId, snapshot, localTransaction: toTransaction(context.row), baselineAvailable: Boolean(baseline),
    changes,
    canApplyRemote: !blocked, ...(blocked ? { applyRemoteBlockedReason: blocked } : {}) };
  return { context, remote, patch, detail };
}
export async function getFeishuIssue(db: D1Database, sourceId: string, recordId: string): Promise<FeishuIssueDetail> {
  return (await issueContext(db, sourceId, recordId)).detail;
}
export async function resolveFeishuIssue(db: D1Database, sourceId: string, recordId: string, snapshot: string,
  action: 'keep-local' | 'use-remote', extra: D1PreparedStatement[] = []) {
  const { context, remote, patch, detail } = await issueContext(db, sourceId, recordId);
  if (snapshot !== detail.snapshot) stale();
  if (action === 'use-remote' && !detail.canApplyRemote) throw new ApiError(422, 'FEISHU_APPLY_BLOCKED', detail.applyRemoteBlockedReason!);
  await commit(context, remote, await digest(JSON.stringify(remote)), null, action === 'use-remote' ? patch : {}, extra);
}
