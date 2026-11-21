import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../server/types';
import type { FeishuSyncStatus } from '../shared/contracts';
import { parseCmb } from '../server/ledger/domain';
import { createTransaction } from '../server/ledger/repository';
import { digest } from '../server/security';
import { ApiError } from '../server/errors';
import { getFeishuIssue, reconcileFeishuRecord, resolveFeishuIssue } from './feishu-reconcile';

const execute = promisify(execFile);
export const feishuConfigSchema = z.object({
  baseToken: z.string().regex(/^[A-Za-z0-9]+$/),
  tableId: z.string().regex(/^tbl[A-Za-z0-9]+$/),
  accountId: z.string().min(1).max(100),
  cliPath: z.string().refine(isAbsolute, '飞书工具需要绝对路径'),
  fieldIds: z.record(z.string(), z.string().regex(/^fld[A-Za-z0-9]+$/)).optional(),
  sourceUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(url.hostname) && !url.username && !url.password;
  }, '飞书来源链接须为有效的飞书 HTTPS 地址').optional(),
});
export type FeishuConfig = z.infer<typeof feishuConfigSchema>;
export type SyncStatus = FeishuSyncStatus & { issues: NonNullable<FeishuSyncStatus['issues']> };
type RecordData = Record<string, unknown>;
const columns = ['交易主体', '金额', '余额', '交易时间原文', '交易类型', '资金方向', '交易摘要', '银行', '币种', '交易指纹', '解析版本'];
const kinds: Record<string, string> = { 消费: 'purchase', 退款: 'refund', 转出: 'transfer_out', 转账转出: 'transfer_out', 转入: 'transfer_in', 转账转入: 'transfer_in', 工资: 'salary', 提现转入: 'wallet_withdrawal', 其他入账: 'credit', 充值转出: 'wallet_topup' };
const directions: Record<string, string> = { 流入: 'inflow', 流出: 'outflow' };
function single(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  throw new Error('字段不是单个文本值');
}
export function decimalText(value: unknown): string {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : single(value);
  if (!/^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) throw new Error('金额须为最多两位小数');
  return text;
}
export function parseFeishuRecord(row: RecordData, accountId: string) {
  const recordId = single(row.record_id);
  if (!/^rec[A-Za-z0-9]+$/.test(recordId)) throw new Error('缺少有效的飞书记录 ID');
  const kind = single(row['交易类型']), direction = single(row['资金方向']);
  const parsed = parseCmb({
    amount: decimalText(row['金额']), transaction_time: single(row['交易时间原文']),
    transaction_type: kinds[kind] ?? kind, direction: directions[direction] ?? direction,
    description: single(row['交易摘要']), counterparty: row['交易主体'] == null ? '' : single(row['交易主体']),
    bank: single(row['银行']), currency: single(row['币种']),
    parser_version: single(row['解析版本']), transaction_fingerprint: single(row['交易指纹']),
    ...(row['余额'] == null ? {} : { balance: decimalText(row['余额']) }),
  }, accountId);
  return { recordId, parsed };
}

/** Credentials stay in lark-cli's existing keychain; only the chosen table is read. */
export async function readFeishuRecords(config: FeishuConfig, dataDir: string): Promise<RecordData[]> {
  const scratch = join(dataDir, 'sync-temp');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(scratch, 'pull-'));
  const records: RecordData[] = [];
  try {
    for (let offset = 0; offset < 100_000;) {
      const output = relative(dataDir, join(directory, `${offset}.ndjson`));
      const args = ['base', '+record-list', '--base-token', config.baseToken, '--table-id', config.tableId,
        ...columns.flatMap(field => ['--field-id', config.fieldIds?.[field] ?? field]), '--limit', '2000', '--offset', String(offset),
        '--format', 'ndjson', '--output', output, '--as', 'user'];
      let stdout: string;
      try { ({ stdout } = await execute(config.cliPath, args, { cwd: dataDir, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })); }
      catch { throw new Error('暂时无法读取飞书，请检查网络或在本机重新登录 lark-cli。'); }
      const manifest = JSON.parse(stdout) as { format?: string; records_count?: number; has_more?: boolean; columns?: Record<string, { field_id?: string }> };
      if (manifest.format !== 'ndjson' || !Number.isInteger(manifest.records_count) || typeof manifest.has_more !== 'boolean') throw new Error('飞书返回格式变化，请更新本地同步程序。');
      const text = await readFile(join(dataDir, output), 'utf8');
      const page = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordData);
      if (page.length !== manifest.records_count) throw new Error('飞书返回的记录数与文件不一致，本次同步未导入。');
      const names = Object.fromEntries(columns.map(name => {
        const id = config.fieldIds?.[name];
        const returnedName = id ? Object.entries(manifest.columns ?? {}).find(([, column]) => column.field_id === id)?.[0] : name;
        if (!returnedName) throw new Error('飞书字段映射已变化，请重新配置同步。');
        return [name, returnedName];
      }));
      records.push(...page.map(row => Object.fromEntries([['record_id', row.record_id], ...columns.map(name => [name, row[names[name]]])])));
      if (!manifest.has_more) return records;
      if (!page.length) throw new Error('飞书分页没有继续前进，本次同步未导入。');
      offset += page.length;
    }
    throw new Error('账单已超过十万条，请调整同步策略后继续。');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function createFeishuIntegration(options: {
  db: D1Database; dataDir: string; config?: FeishuConfig | null;
  readRecords?: (config: FeishuConfig, dataDir: string) => Promise<RecordData[]>;
}) {
  const { db, dataDir } = options;
  const config = options.config ? feishuConfigSchema.parse(options.config) : null;
  const sourceId = config ? `${config.baseToken}:${config.tableId}:${config.accountId}` : 'unconfigured';
  const persisted = await db.prepare('SELECT value FROM local_integration_state WHERE id=?').bind(sourceId).first<{ value: string }>();
  let state: SyncStatus = { configured: Boolean(config), lastSyncAt: null, lastSuccessAt: null, lastError: null, recordCount: 0, issues: [], ...(persisted ? JSON.parse(persisted.value) : {}), syncing: false };
  let inFlight: Promise<SyncStatus> | null = null;
  let resolving: Promise<SyncStatus> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const recordUrl = (recordId?: string) => {
    if (!config) return undefined;
    const url = new URL(config.sourceUrl ?? `https://www.feishu.cn/base/${config.baseToken}`);
    url.search = ''; url.hash = ''; url.searchParams.set('table', config.tableId);
    if (recordId && /^rec[A-Za-z0-9]+$/.test(recordId)) url.searchParams.set('record', recordId);
    return url.toString();
  };
  const status = () => ({ ...state, sourceUrl: recordUrl(), issues: state.issues.map(issue => ({ ...issue, kind: issue.kind ?? 'invalid' as const, recordUrl: recordUrl(issue.recordId) })) });
  const persistStatement = (value: SyncStatus) => db.prepare('INSERT INTO local_integration_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
    .bind(sourceId, JSON.stringify({ ...value, syncing: false }));
  const persist = async () => persistStatement(state).run();
  const refreshPendingIssues = async () => {
    const pending = (await db.prepare(`SELECT f.record_id,t.id,t.description,t.occurred_at,t.amount_cents
      FROM local_feishu_records f JOIN transactions t ON t.id=f.transaction_id
      WHERE f.source_id=? AND f.pending_snapshot IS NOT NULL`).bind(sourceId).all()).results as unknown as {
        record_id: string; id: string; description: string; occurred_at: string; amount_cents: number;
      }[];
    const ids = new Set(pending.map(row => row.record_id));
    const invalidIds = new Set(state.issues.filter(issue => issue.kind === 'invalid').map(issue => issue.recordId));
    state.issues = [...state.issues.filter(issue => issue.kind === 'invalid' || issue.kind !== 'changed' && !ids.has(issue.recordId)), ...pending.filter(row => !invalidIds.has(row.record_id)).map(row => ({
      recordId: row.record_id, kind: 'changed' as const, recordUrl: recordUrl(row.record_id), transactionId: row.id,
      description: row.description, occurredAt: row.occurred_at, amountCents: row.amount_cents,
      message: '飞书中的交易信息有变更，请查看差异并选择保留哪一份。',
    }))];
    if (!state.lastError || /^\d+ 条飞书账单需要核对。$/.test(state.lastError)) {
      state.lastError = state.issues.length ? `${state.issues.length} 条飞书账单需要核对。` : null;
    }
  };
  // Pending source snapshots are authoritative even if the process stopped before saving the UI status.
  await refreshPendingIssues();
  async function performSync(): Promise<SyncStatus> {
    if (!config) return status();
    state = { ...state, syncing: true, lastSyncAt: new Date().toISOString(), lastError: null };
    try {
      const rows = await (options.readRecords ?? readFeishuRecords)(config, dataDir);
      state.issues = [];
      for (const row of rows) {
        const recordId = typeof row.record_id === 'string' ? row.record_id : 'unknown';
        try {
          const { parsed } = parseFeishuRecord(row, config.accountId);
          const sourceHash = await digest(JSON.stringify(parsed));
          const prior = await reconcileFeishuRecord(db, sourceId, recordId, parsed, sourceHash);
          if (prior) {
            if (prior.changed) state.issues.push({ recordId, kind: 'changed', recordUrl: recordUrl(recordId),
              transactionId: prior.transaction.id, description: prior.transaction.description, occurredAt: prior.transaction.occurredAt,
              amountCents: prior.transaction.amountCents, message: '飞书中的交易信息有变更，请查看差异并选择保留哪一份。' });
            continue;
          }
          const result = await createTransaction(db, parsed.transaction, { source: 'shortcut', scope: `shortcut:${config.accountId}`,
            key: `lark:${config.tableId}:${recordId}`, fingerprint: parsed.fingerprint, needsReview: parsed.needsReview, sourceDetails: parsed.sourceDetails });
          await db.prepare('INSERT INTO local_feishu_records(source_id,record_id,source_hash,transaction_id,source_snapshot) VALUES(?,?,?,?,?) ON CONFLICT(source_id,record_id) DO NOTHING')
            .bind(sourceId, recordId, sourceHash, result.transaction.id, JSON.stringify(parsed)).run();
        } catch (error) { state.issues.push({ recordId, kind: 'invalid', recordUrl: recordUrl(recordId),
          message: error instanceof ApiError && error.status === 409 ? '本地账单正在变化，请再次同步。' : '账单未导入，请检查飞书中的金额、时间和交易类型。' }); }
      }
      state.recordCount = Number(await db.prepare('SELECT COUNT(*) FROM local_feishu_records WHERE source_id=?').bind(sourceId).first('COUNT(*)'));
      await refreshPendingIssues();
      state.lastError = state.issues.length ? `${state.issues.length} 条飞书账单需要核对。` : null;
      if (!state.issues.length) state.lastSuccessAt = new Date().toISOString();
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : '同步暂未完成，请稍后重试。';
    } finally {
      state.syncing = false;
      await refreshPendingIssues();
      await persist();
    }
    return status();
  }
  function sync(): Promise<SyncStatus> {
    if (resolving) return resolving.then(() => sync());
    if (!inFlight) inFlight = performSync().finally(() => { inFlight = null; });
    return inFlight;
  }
  const routes = new Hono<ApiEnv>();
  const requireValidSource = (recordId: string) => {
    if (state.issues.some(issue => issue.recordId === recordId && issue.kind === 'invalid')) {
      throw new ApiError(422, 'FEISHU_SOURCE_INVALID', '飞书记录暂时无法解析，请先在飞书修正后重新同步。');
    }
  };
  routes.get('/feishu/status', async c => { await refreshPendingIssues(); return c.json({ data: status() }); });
  routes.post('/feishu/sync', async c => c.json({ data: await sync() }));
  const recordIdSchema = z.string().regex(/^rec[A-Za-z0-9]+$/);
  routes.get('/feishu/issues/:recordId', async c => {
    const recordId = recordIdSchema.parse(c.req.param('recordId'));
    requireValidSource(recordId);
    const detail = await getFeishuIssue(db, sourceId, recordId);
    return c.json({ data: { ...detail, recordUrl: recordUrl(recordId) } });
  });
  routes.post('/feishu/issues/:recordId/resolve', async c => {
    const recordId = recordIdSchema.parse(c.req.param('recordId'));
    requireValidSource(recordId);
    const { snapshot, action } = z.object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['keep-local', 'use-remote']) }).parse(await c.req.json());
    if (inFlight || resolving) throw new ApiError(409, 'FEISHU_SYNC_BUSY', '正在同步或处理记录，请稍后重新查看差异。');
    const performResolve = async () => {
      const issues = state.issues.filter(issue => issue.recordId !== recordId);
      const next = { ...state, issues };
      if (state.lastError === `${state.issues.length} 条飞书账单需要核对。`) next.lastError = issues.length ? `${issues.length} 条飞书账单需要核对。` : null;
      if (!issues.length && !next.lastError && next.lastSyncAt) next.lastSuccessAt = next.lastSyncAt;
      await resolveFeishuIssue(db, sourceId, recordId, snapshot, action, [persistStatement(next)]);
      state = next;
      return status();
    };
    resolving = performResolve().finally(() => { resolving = null; });
    return c.json({ data: await resolving });
  });
  return { routes, status, sync,
    start() { if (!config || timer) return; void sync().catch(() => {}); timer = setInterval(() => { void sync().catch(() => {}); }, 5 * 60_000); timer.unref(); },
    async stop() { if (timer) clearInterval(timer); timer = undefined; await Promise.all([inFlight, resolving]); },
  };
}
