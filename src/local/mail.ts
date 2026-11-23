import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../server/types';
import type {
  MailIssueDetail, MailIssueDraft, MailSyncIssue, MailSyncProgress, MailSyncStatus, TransactionKind, TransferDirection,
} from '../shared/contracts';
import { ApiError } from '../server/errors';
import { normalizeInput, parseInput, transactionInputSchema } from '../server/ledger/domain';
import { createTransaction } from '../server/ledger/repository';
import { isLikelyCmbEmailHeader, parseCmbEmailBody } from '../server/ledger/cmb-email-parser';
import {
  addDaysIsoDate,
  fetchSingleImapMessage,
  pullImapMessages,
  testImapConnection,
  type FetchedMessage,
  type ImapConnectionOptions,
  type ImapPullQuery,
  type ImapPullResult,
  type MailboxStatus,
} from './imap';
import { createMacOsKeychainStore, type MailSecretStore } from './keychain';

const QQ_HOST = 'imap.qq.com';
const QQ_PORT = 993;
const QQ_MAILBOX = 'INBOX';
const DEFAULT_ACCOUNT_ID = 'cmb-default';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const mailConfigSchema = z.object({
  provider: z.literal('qq').default('qq'),
  email: z.string().trim().toLowerCase().email('请填写有效的 QQ 邮箱地址').refine(
    value => /@(?:qq|vip\.qq|foxmail)\.com$/i.test(value),
    '当前支持 QQ 邮箱（@qq.com、@vip.qq.com、@foxmail.com）',
  ),
  host: z.literal(QQ_HOST).default(QQ_HOST),
  port: z.literal(QQ_PORT).default(QQ_PORT),
  mailbox: z.literal(QQ_MAILBOX).default(QQ_MAILBOX),
  accountId: z.string().trim().min(1).max(100).default(DEFAULT_ACCOUNT_ID),
  syncStartDate: z.string().regex(ISO_DATE_RE, '起始日期格式须为 YYYY-MM-DD'),
});

export type MailConfig = z.infer<typeof mailConfigSchema>;

const saveConfigInputSchema = z.object({
  email: mailConfigSchema.shape.email,
  authCode: z.string().trim().min(6, '请填写 QQ 邮箱 16 位 IMAP 授权码').max(128).optional(),
  syncStartDate: z.string().regex(ISO_DATE_RE, '起始日期格式须为 YYYY-MM-DD'),
  accountId: z.string().trim().min(1).max(100).optional(),
});

const syncRangeInputSchema = z.object({
  startDate: z.string().regex(ISO_DATE_RE, '开始日期格式须为 YYYY-MM-DD'),
  endDate: z.string().regex(ISO_DATE_RE, '结束日期格式须为 YYYY-MM-DD'),
}).optional();

interface LearnedMailTemplate {
  kind: TransactionKind;
  transferDirection?: TransferDirection;
  categoryId?: string | null;
}

interface PersistedMailState {
  uidValidity: number | null;
  lastUid: number;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  unfilteredBackfillComplete?: boolean;
  learnedTemplates?: Record<string, LearnedMailTemplate>;
}

export interface MailTransport {
  testConnection(options: ImapConnectionOptions): Promise<MailboxStatus>;
  pullMessages(options: ImapConnectionOptions, query: ImapPullQuery): Promise<ImapPullResult>;
  fetchMessage?(options: ImapConnectionOptions, expectedUidValidity: number, uid: number): Promise<FetchedMessage | null>;
}

const defaultTransport: MailTransport = {
  testConnection: testImapConnection,
  pullMessages: pullImapMessages,
  fetchMessage: fetchSingleImapMessage,
};

function cleanBodyPreview(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const startIdx = normalized.search(/您(?:的)?账户\s*[0-9]+\s*于/);
  if (startIdx >= 0) {
    const slice = normalized.slice(Math.max(0, startIdx - 40), startIdx + 1200).trim();
    return slice.slice(0, 1500);
  }
  return normalized.slice(0, 1500);
}

export function extractActionTemplate(body: string): string | null {
  const text = body.replace(/\r\n/g, '\n');
  const match = /您(?:的)?账户\s*[0-9]+\s*于\s*(?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日(?:\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])?\s*([^\d\r\n，,。；;（(]+?)\s*(?:人民币\s*)?[0-9]/.exec(text);
  if (!match) return null;
  const key = match[1].replace(/\s+/g, '').trim();
  return key.length >= 2 && key.length <= 30 ? key : null;
}

export function extractMailIssueDraft(body: string, mailDateIso: string | null): MailIssueDraft {
  const text = body.replace(/\r\n/g, '\n');
  const lineMatch = /(您(?:的)?账户\s*[0-9]+\s*于[^\n]+)/.exec(text);
  const summaryLine = (lineMatch?.[1] ?? text.split('\n').find(l => l.trim()) ?? '').trim();

  // Best-effort date/time extraction (supports both MM月DD日HH:mm and MM月DD日)
  let occurredAt: string | null = null;
  const timeMatch = /((?:0?[1-9]|1[0-2]))月\s*((?:0?[1-9]|[12][0-9]|3[01]))日(?:\s*((?:[01]?[0-9]|2[0-3]))[:：]([0-5][0-9]))?/.exec(summaryLine);
  const ref = mailDateIso ? new Date(mailDateIso) : new Date();
  if (timeMatch && Number.isFinite(ref.valueOf())) {
    const shanghaiRef = new Date(ref.valueOf() + 8 * 60 * 60 * 1000);
    const txMonth = Number(timeMatch[1]);
    let year = shanghaiRef.getUTCFullYear();
    const refMonth = shanghaiRef.getUTCMonth() + 1;
    if (txMonth === 12 && refMonth === 1) year -= 1;
    else if (txMonth === 1 && refMonth === 12) year += 1;
    const mm = String(txMonth).padStart(2, '0');
    const dd = String(Number(timeMatch[2])).padStart(2, '0');
    const fallbackHm = shanghaiRef.toISOString().slice(11, 16);
    const hh = timeMatch[3] !== undefined ? String(Number(timeMatch[3])).padStart(2, '0') : fallbackHm.slice(0, 2);
    const mi = timeMatch[4] !== undefined ? timeMatch[4] : fallbackHm.slice(3, 5);
    occurredAt = `${year}-${mm}-${dd}T${hh}:${mi}:00+08:00`;
  } else if (mailDateIso && Number.isFinite(ref.valueOf())) {
    const shanghaiRef = new Date(ref.valueOf() + 8 * 60 * 60 * 1000);
    occurredAt = `${shanghaiRef.toISOString().slice(0, 16)}:00+08:00`;
  }

  // Best-effort amount extraction (avoid matching account digits or balance after 余额)
  const [beforeBalanceRaw, afterBalanceRaw = ''] = summaryLine.split(/余额/);
  const beforeBalance = beforeBalanceRaw ?? summaryLine;
  const amountMatch = /(?:人民币\s*|支出|收入|入账|收款|扣款|转出|转入|支付|消费|退款|转账|付款|代扣|汇款|申购|赎回)?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*元/.exec(beforeBalance)
    ?? /人民币\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/.exec(beforeBalance);
  const amount = amountMatch ? amountMatch[1].replaceAll(',', '') : null;

  // Best-effort kind guess
  let kind: MailIssueDraft['kind'] = 'expense';
  let transferDirection: MailIssueDraft['transferDirection'];
  if (/退款|退回|退费/.test(beforeBalance)) {
    kind = 'refund';
  } else if (/转入|提现|赎回|朝朝宝转出/.test(beforeBalance)) {
    kind = 'transfer';
    transferDirection = 'inflow';
  } else if (/转出|转至|转账|充值|申购|朝朝宝转入|信用卡还款|自动还款/.test(beforeBalance)) {
    kind = 'transfer';
    transferDirection = 'outflow';
  } else if (/入账|收款|结息|利息|工资|分红|到账/.test(beforeBalance)) {
    kind = 'income';
  }

  const actionClause = beforeBalance
    .replace(/^您(?:的)?账户\s*[0-9]+\s*于\s*(?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日(?:\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])?\s*/, '')
    .replace(/[，,。.\s]*$/, '')
    .replace(/\s*(?:人民币\s*)?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\s*(?:元)?\s*$/, '')
    .replace(/[，,]\s*$/, '')
    .trim();

  const afterParenMatch = /[（(](?!\s*[）)])((?:(?!您(?:的)?账户)[^\r\n])+)\s*[）)]/.exec(afterBalanceRaw);
  const afterPartyMatch = /(?:付方|收款人|收款方)\s*([^\r\n，,。]+)/.exec(afterBalanceRaw);
  const afterRemarkMatch = /备注\s*[:：]\s*([^\r\n。]+)/.exec(afterBalanceRaw);

  let description = actionClause;
  if (afterParenMatch?.[1]?.trim()) {
    description = afterParenMatch[1].trim();
  } else if (afterPartyMatch?.[1]?.trim()) {
    const party = afterPartyMatch[1].trim();
    description = actionClause ? `${actionClause} - ${party}` : party;
  } else if (afterRemarkMatch?.[1]?.trim()) {
    const remark = afterRemarkMatch[1].trim();
    description = actionClause ? `${actionClause}（${remark}）` : remark;
  }
  description = description.trim().slice(0, 120) || '招商银行交易';

  return { occurredAt, amount, description, kind, ...(transferDirection ? { transferDirection } : {}) };
}

function shanghaiTodayIso(now = new Date()): string {
  return new Date(now.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shanghaiDateOfIso(iso: string): string {
  return new Date(new Date(iso).valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sourceKey(config: MailConfig): string {
  return `qq:${config.email}:${config.mailbox}:${config.accountId}`;
}

function stateKey(config: MailConfig): string {
  return `mail:${sourceKey(config)}`;
}

async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function loadMailConfig(dataDir: string): Promise<MailConfig | null> {
  try {
    const raw = await readFile(join(dataDir, 'mail.json'), 'utf8');
    return mailConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('本地邮箱配置格式不正确，请检查 mail.json。');
  }
}

export async function createMailIntegration(options: {
  db: D1Database;
  dataDir: string;
  config?: MailConfig | null;
  secretStore?: MailSecretStore;
  transport?: MailTransport;
  now?: () => Date;
}) {
  const { db, dataDir } = options;
  const secretStore = options.secretStore ?? createMacOsKeychainStore();
  const transport = options.transport ?? defaultTransport;
  const now = options.now ?? (() => new Date());
  const configPath = join(dataDir, 'mail.json');

  let config: MailConfig | null = options.config === undefined
    ? await loadMailConfig(dataDir)
    : options.config ? mailConfigSchema.parse(options.config) : null;

  let persisted: PersistedMailState = {
    uidValidity: null, lastUid: 0, lastSyncAt: null, lastSuccessAt: null, lastError: null,
    unfilteredBackfillComplete: false,
  };
  let syncing = false;
  let progress: MailSyncProgress | null = null;
  let mutating = false;
  let inFlight: Promise<MailSyncStatus> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;

  async function loadPersistedState(active: MailConfig | null): Promise<PersistedMailState> {
    if (!active) return { uidValidity: null, lastUid: 0, lastSyncAt: null, lastSuccessAt: null, lastError: null, unfilteredBackfillComplete: false };
    const row = await db.prepare('SELECT value FROM local_integration_state WHERE id=?').bind(stateKey(active)).first<{ value: string }>();
    if (!row) return { uidValidity: null, lastUid: 0, lastSyncAt: null, lastSuccessAt: null, lastError: null, unfilteredBackfillComplete: false };
    try {
      const parsed = JSON.parse(row.value) as Partial<PersistedMailState>;
      return {
        uidValidity: typeof parsed.uidValidity === 'number' ? parsed.uidValidity : null,
        lastUid: typeof parsed.lastUid === 'number' ? parsed.lastUid : 0,
        lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
        lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
        unfilteredBackfillComplete: parsed.unfilteredBackfillComplete === true,
        learnedTemplates: parsed.learnedTemplates && typeof parsed.learnedTemplates === 'object' ? parsed.learnedTemplates : {},
      };
    } catch {
      return { uidValidity: null, lastUid: 0, lastSyncAt: null, lastSuccessAt: null, lastError: null, unfilteredBackfillComplete: false };
    }
  }

  async function savePersistedState(active: MailConfig, value: PersistedMailState): Promise<void> {
    await db.prepare('INSERT INTO local_integration_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .bind(stateKey(active), JSON.stringify(value)).run();
  }

  persisted = await loadPersistedState(config);

  async function computeSuggestedStartDate(accountId = DEFAULT_ACCOUNT_ID): Promise<string> {
    const latest = await db.prepare(
      'SELECT MAX(occurred_at) AS latest FROM transactions WHERE account_id=? AND deleted_at IS NULL',
    ).bind(accountId).first<{ latest: string | null }>();
    if (latest?.latest) {
      // Overlap by 1 day so no transaction is missed during Feishu -> QQ Mail handoff.
      return addDaysIsoDate(shanghaiDateOfIso(latest.latest), -1);
    }
    return addDaysIsoDate(shanghaiTodayIso(now()), -7);
  }

  async function readCountsAndIssues(active: MailConfig | null) {
    if (!active) return { recordCount: 0, skippedExistingCount: 0, issueCount: 0, dismissedIssueCount: 0, issues: [] };
    const sid = sourceKey(active);
    const [counts, issueRows] = await db.batch([
      db.prepare(`SELECT COUNT(*) FILTER (WHERE status='imported') AS recordCount,
        COUNT(*) FILTER (WHERE status='skipped_existing') AS skippedExistingCount,
        COUNT(*) FILTER (WHERE status='invalid') AS issueCount,
        COUNT(*) FILTER (WHERE dismissed_by_user=1) AS dismissedIssueCount
        FROM local_mail_messages WHERE source_id=?`).bind(sid),
      db.prepare(`SELECT uid_validity, uid, subject, mail_date, error_message
        FROM local_mail_messages
        WHERE source_id=? AND status='invalid'
        ORDER BY COALESCE(mail_date, processed_at) DESC, uid DESC
        LIMIT 50`).bind(sid),
    ]);
    const totals = counts.results[0] as { recordCount: number; skippedExistingCount: number; issueCount: number; dismissedIssueCount: number };
    const issues: MailSyncIssue[] = (issueRows.results as unknown as {
      uid_validity: number; uid: number; subject: string; mail_date: string | null; error_message: string | null;
    }[]).map(row => ({
      uidValidity: row.uid_validity,
      uid: row.uid,
      subject: row.subject || '招商银行邮件',
      mailDate: row.mail_date,
      message: row.error_message || '邮件暂未自动解析，请核对。',
    }));
    return { ...totals, issues };
  }

  async function buildStatus(): Promise<MailSyncStatus> {
    const accountId = config?.accountId ?? DEFAULT_ACCOUNT_ID;
    const [suggestedStartDate, stats] = await Promise.all([
      computeSuggestedStartDate(accountId),
      readCountsAndIssues(config),
    ]);
    const issueError = stats.issueCount ? `${stats.issueCount} 封招行邮件需要核对。` : null;
    const lastError = persisted.lastError ?? issueError;
    return {
      configured: Boolean(config),
      provider: 'qq',
      email: config?.email ?? null,
      mailbox: config?.mailbox ?? QQ_MAILBOX,
      accountId,
      syncStartDate: config?.syncStartDate ?? null,
      suggestedStartDate,
      lastSyncAt: persisted.lastSyncAt,
      lastSuccessAt: persisted.lastSuccessAt,
      lastError,
      ...stats,
      syncing,
      progress: syncing && progress ? { ...progress } : null,
    };
  }

  type MailMessage = Pick<FetchedMessage, 'uid' | 'internalDate' | 'decodeError'> & {
    email: Pick<FetchedMessage['email'], 'messageId' | 'date' | 'subject' | 'text'>;
  };

  function receipt(active: MailConfig, uidValidity: number, uid: number) {
    // The bounded key also round-trips through application backups without exposing the mailbox address.
    const sourceHash = createHash('sha256').update(sourceKey(active)).digest('hex');
    return { scope: `mail:${active.accountId}`, key: `imap:${sourceHash}:${uidValidity}:${uid}` };
  }

  async function processMessage(active: MailConfig, sid: string, uidValidity: number, message: MailMessage, retryInvalid: boolean) {
    const { email, uid } = message;
    const checkpoint = await db.prepare('SELECT status FROM local_mail_messages WHERE source_id=? AND uid_validity=? AND uid=?')
      .bind(sid, uidValidity, uid).first<{ status: string }>();
    if (checkpoint && (checkpoint.status !== 'invalid' || !retryInvalid)) return 'skipped';

    const date = email.date ?? message.internalDate;
    const mailDate = date?.toISOString() ?? null;
    let unmatchedTemplate: string | null = null;
    const finish = async (status: 'imported' | 'skipped_existing' | 'ignored' | 'invalid', transactionId: string | null = null,
      error: string | null = null) => {
      const preview = status === 'invalid' ? cleanBodyPreview(email.text) : null;
      const complete = Boolean(preview && !message.decodeError && preview === email.text.trim());
      await db.prepare(`INSERT INTO local_mail_messages
        (source_id,uid_validity,uid,message_id,mail_date,subject,status,transaction_id,error_message,processed_at,body_preview,body_complete,unmatched_template)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,uid_validity,uid) DO UPDATE SET
        message_id=excluded.message_id,mail_date=excluded.mail_date,subject=excluded.subject,status=excluded.status,
        transaction_id=excluded.transaction_id,error_message=excluded.error_message,processed_at=excluded.processed_at,
        body_preview=excluded.body_preview,body_complete=excluded.body_complete,unmatched_template=excluded.unmatched_template
        WHERE local_mail_messages.status IS NOT excluded.status OR local_mail_messages.message_id IS NOT excluded.message_id
          OR local_mail_messages.subject IS NOT excluded.subject OR local_mail_messages.mail_date IS NOT excluded.mail_date
          OR local_mail_messages.transaction_id IS NOT excluded.transaction_id OR local_mail_messages.error_message IS NOT excluded.error_message
          OR local_mail_messages.body_preview IS NOT excluded.body_preview OR local_mail_messages.body_complete IS NOT excluded.body_complete
          OR local_mail_messages.unmatched_template IS NOT excluded.unmatched_template`)
        .bind(sid, uidValidity, uid, email.messageId, mailDate, email.subject.slice(0, 200), status, transactionId,
          error, now().toISOString(), preview, Number(complete), status === 'invalid' ? unmatchedTemplate : null).run();
      return status;
    };

    const identity = receipt(active, uidValidity, uid);
    const recorded = await db.prepare('SELECT id FROM transactions WHERE idempotency_scope=? AND idempotency_key=?')
      .bind(identity.scope, identity.key).first<{ id: string }>();
    if (recorded) {
      await finish('imported', recorded.id);
      return 'skipped';
    }
    if (email.messageId) {
      const duplicate = await db.prepare(`SELECT transaction_id FROM local_mail_messages WHERE source_id=? AND message_id=?
        AND status IN ('imported','skipped_existing') LIMIT 1`).bind(sid, email.messageId).first<{ transaction_id: string | null }>();
      if (duplicate) return finish('skipped_existing', duplicate.transaction_id);
    }
    if (message.decodeError) return finish('invalid', null, message.decodeError);

    const result = await parseCmbEmailBody(email.text, active.accountId, date ?? now());
    if (result.status === 'not_transaction') return finish('ignored');
    if (result.status === 'ambiguous' || result.status === 'invalid_date') return finish('invalid', null, result.message);

    // Old backups may contain account-only receipts without the local mailbox checkpoints.
    // A linked receipt belongs to its recorded source. An unlinked one needs an explicit decision.
    const unclaimed = await db.prepare(`SELECT t.id FROM transactions t
      WHERE ((t.idempotency_scope=? AND t.idempotency_key=?) OR (t.idempotency_scope=? AND t.idempotency_key=?))
      AND NOT EXISTS(SELECT 1 FROM local_mail_messages m WHERE m.transaction_id=t.id AND m.status='imported') LIMIT 1`)
      .bind(identity.scope, `imap:${uidValidity}:${uid}`, `mail-manual:${active.accountId}`, `mail-manual:${uidValidity}:${uid}`)
      .first<{ id: string }>();
    if (unclaimed) return finish('invalid', null, '旧版账单回执缺少邮箱来源，请核对已有账单；已入账可忽略，否则请补录。');

    const parsed = result.status === 'parsed' ? result.parsed : null;
    let input = parsed?.transaction;
    if (parsed) {
      const legacy = await db.prepare(`SELECT id FROM transactions WHERE account_id=? AND fingerprint=? AND occurred_at=?
        AND amount_cents=? AND deleted_at IS NULL AND (idempotency_key IS NULL OR idempotency_key NOT LIKE 'imap:%') LIMIT 1`)
        .bind(active.accountId, parsed.fingerprint, parsed.transaction.occurredAt, parsed.transaction.amountCents).first<{ id: string }>();
      if (legacy) return finish('skipped_existing', legacy.id);
    }
    try {
      if (result.status === 'unmatched') {
        unmatchedTemplate = extractActionTemplate(email.text);
        const rule = unmatchedTemplate ? persisted.learnedTemplates?.[unmatchedTemplate] : undefined;
        const draft = rule ? extractMailIssueDraft(email.text, mailDate) : null;
        if (!rule || !draft?.amount || !draft.occurredAt) return finish('invalid', null, result.message);
        input = normalizeInput(parseInput(transactionInputSchema, {
          accountId: active.accountId, occurredAt: draft.occurredAt, kind: rule.kind,
          transferDirection: rule.transferDirection, amount: draft.amount, description: draft.description,
          categoryId: rule.categoryId ?? null, categoryOverride: Boolean(rule.categoryId), note: '',
        }));
      }
      if (!input) throw new Error('无法解析邮件账单。');
      const created = await createTransaction(db, input, {
        ...identity, source: 'import', fingerprint: parsed?.fingerprint, needsReview: parsed?.needsReview, sourceDetails: parsed?.sourceDetails,
      });
      return finish('imported', created.transaction.id);
    } catch (error) {
      return finish('invalid', null, error instanceof ApiError && error.status === 409
        ? '本地账单正在变化，请稍后重试同步。' : '账单保存失败，请核对邮件内容。');
    }
  }

  async function resolvePendingIssues(active: MailConfig, learnedTemplate?: string): Promise<number> {
    const sid = sourceKey(active);
    const pending = await db.prepare(`SELECT uid_validity, uid, message_id, mail_date, subject, body_preview, body_complete
      FROM local_mail_messages WHERE source_id=? AND status='invalid' ORDER BY uid`).bind(sid).all<{
      uid_validity: number; uid: number; message_id: string | null; mail_date: string | null; subject: string;
      body_preview: string | null; body_complete: number | null;
    }>();
    let resolved = 0;
    let authCode: string | null | undefined;
    for (const row of pending.results) {
      if (row.body_preview === '') continue; // Oversized or undecodable mail requires manual review.
      if (learnedTemplate && row.body_preview && extractActionTemplate(row.body_preview) !== learnedTemplate) continue;
      let message: MailMessage | null = null;
      if (row.body_complete && row.body_preview) {
        message = { uid: row.uid, internalDate: null, email: { date: row.mail_date ? new Date(row.mail_date) : null,
          messageId: row.message_id, subject: row.subject, text: row.body_preview } };
      } else if ((learnedTemplate || row.body_complete === null || row.body_preview === null) && transport.fetchMessage) {
        if (authCode === undefined) authCode = await secretStore.get(active.email);
        if (authCode) message = await transport.fetchMessage({ ...active, authCode }, row.uid_validity, row.uid).catch(() => null);
      }
      if (message && await processMessage(active, sid, row.uid_validity, message, true) !== 'invalid') resolved++;
    }
    return resolved;
  }

  async function performSync(range?: { startDate: string; endDate: string }): Promise<MailSyncStatus> {
    const active = config;
    if (!active) return buildStatus();
    syncing = true;
    progress = { total: 0, processed: 0, imported: 0 };
    persisted = { ...persisted, lastSyncAt: now().toISOString(), lastError: null };
    const sid = sourceKey(active);
    let streamed = false;
    try {
      const authCode = await secretStore.get(active.email);
      if (!authCode) {
        throw new Error('系统钥匙串中未找到该邮箱的授权码，请重新输入授权码连接。');
      }
      const onProgress = (info: { total: number; processed: number }) => {
        progress = { total: info.total, processed: info.processed, imported: progress?.imported ?? 0 };
      };
      const onBatch = async (batch: FetchedMessage[], mailbox: MailboxStatus) => {
        streamed = true;
        for (const message of batch) {
          const outcome = await processMessage(active, sid, mailbox.uidValidity, message, Boolean(range));
          if (outcome === 'imported' && progress) progress.imported += 1;
        }
      };

      const baseQuery: ImapPullQuery = {
        headerFilter: h => isLikelyCmbEmailHeader(h.headers.from, h.headers.subject),
        onProgress,
        onBatch,
      };
      const needsBackfill = !range && !persisted.unfilteredBackfillComplete;
      let query: ImapPullQuery;
      if (range) {
        query = {
          ...baseQuery,
          sinceDate: range.startDate,
          beforeDate: addDaysIsoDate(range.endDate, 1),
        };
      } else if (needsBackfill || persisted.uidValidity === null || persisted.lastUid === 0) {
        query = { ...baseQuery, sinceDate: active.syncStartDate };
      } else {
        query = {
          ...baseQuery,
          expectedUidValidity: persisted.uidValidity,
          fromUid: persisted.lastUid,
          fallbackSinceDate: active.syncStartDate,
        };
      }

      const pulled = await transport.pullMessages({
        host: active.host,
        port: active.port,
        email: active.email,
        authCode,
        mailbox: active.mailbox,
      }, query);

      const uidValidity = pulled.mailbox.uidValidity;

      // Support mock transports in unit tests that return messages directly without calling onBatch.
      if (!streamed && pulled.messages.length) {
        progress = { total: pulled.messages.length, processed: 0, imported: 0 };
        for (const message of pulled.messages) {
          const outcome = await processMessage(active, sid, uidValidity, message, Boolean(range));
          progress.processed += 1;
          if (outcome === 'imported') progress.imported += 1;
        }
      }

      await resolvePendingIssues(active);
      const stats = await readCountsAndIssues(active);
      // A bounded rescan cannot establish the incremental checkpoint.
      if (!range) {
        const maxSeen = Math.max(pulled.scannedMaxUid ?? 0, (pulled.mailbox.uidNext ?? 1) - 1);
        persisted.lastUid = persisted.uidValidity === uidValidity ? Math.max(persisted.lastUid, maxSeen) : maxSeen;
        persisted.uidValidity = uidValidity;
        persisted.unfilteredBackfillComplete = true;
      }
      persisted.lastError = null;
      if (!stats.issueCount) persisted.lastSuccessAt = now().toISOString();
    } catch (error) {
      persisted.lastError = error instanceof Error ? error.message : 'QQ 邮箱同步暂未完成，请稍后重试。';
    } finally {
      syncing = false;
      progress = null;
      if (config && sourceKey(config) === sourceKey(active)) {
        await savePersistedState(active, persisted);
      }
    }
    return buildStatus();
  }

  /** Wait briefly so fast syncs return final status inline, while large historical syncs continue in background without HTTP timeout. */
  async function waitBrieflyForSync(task: Promise<MailSyncStatus>, maxWaitMs = 15_000): Promise<MailSyncStatus> {
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<MailSyncStatus>(resolve => {
          timerId = setTimeout(() => { void buildStatus().then(resolve); }, maxWaitMs);
          timerId.unref();
        }),
      ]);
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }

  function sync(range?: { startDate: string; endDate: string }): Promise<MailSyncStatus> {
    if (mutating) throw new ApiError(409, 'MAIL_SYNC_BUSY', '邮箱设置或待核对邮件正在更新，请稍候再试。');
    if (range) {
      if (range.startDate > range.endDate) {
        throw new ApiError(422, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期。');
      }
      const spanDays = Math.round((Date.parse(`${range.endDate}T00:00:00Z`) - Date.parse(`${range.startDate}T00:00:00Z`)) / 86_400_000);
      if (spanDays > 366) {
        throw new ApiError(422, 'DATE_RANGE_TOO_LARGE', '单次补扫范围不能超过 366 天。');
      }
      if (inFlight) throw new ApiError(409, 'MAIL_SYNC_BUSY', '正在同步邮件，请稍候再试。');
      inFlight = performSync(range).finally(() => { inFlight = null; });
      return inFlight;
    }
    return startRegularSync();
  }

  function startRegularSync(): Promise<MailSyncStatus> {
    if (!inFlight) inFlight = performSync().finally(() => { inFlight = null; });
    return inFlight;
  }

  function ensureTimer(): void {
    if (!started || !config || timer) return;
    timer = setInterval(() => {
      if (!mutating) void sync().catch(() => {});
    }, 5 * 60_000);
    timer.unref();
  }

  function clearTimer(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  const routes = new Hono<ApiEnv>();

  routes.use('/mail/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.path.endsWith('/mail/sync')) return next();
    if (inFlight || mutating) throw new ApiError(409, 'MAIL_SYNC_BUSY', '邮件同步或更新正在进行，请稍候再试。');
    mutating = true;
    try { await next(); } finally { mutating = false; }
  });

  routes.get('/mail/status', async c => c.json({ data: await buildStatus() }));

  routes.post('/mail/config', async c => {
    const body = saveConfigInputSchema.parse(await c.req.json());
    const accountId = body.accountId ?? config?.accountId ?? DEFAULT_ACCOUNT_ID;
    const account = await db.prepare('SELECT id, archived FROM accounts WHERE id=?').bind(accountId).first<{ id: string; archived: number }>();
    if (!account || account.archived) throw new ApiError(422, 'INVALID_ACCOUNT', '目标账户不存在或已停用。');

    let authCode = body.authCode;
    if (!authCode) {
      if (config && config.email === body.email) {
        authCode = (await secretStore.get(body.email)) ?? undefined;
      }
      if (!authCode) throw new ApiError(422, 'AUTH_CODE_REQUIRED', '请填写 QQ 邮箱 16 位 IMAP 授权码。');
    }

    const nextConfig: MailConfig = mailConfigSchema.parse({
      provider: 'qq',
      email: body.email,
      host: QQ_HOST,
      port: QQ_PORT,
      mailbox: QQ_MAILBOX,
      accountId,
      syncStartDate: body.syncStartDate,
    });

    try {
      await transport.testConnection({
        host: nextConfig.host,
        port: nextConfig.port,
        email: nextConfig.email,
        authCode,
        mailbox: nextConfig.mailbox,
      });
    } catch (error) {
      throw new ApiError(422, 'MAIL_CONNECTION_FAILED', error instanceof Error ? error.message : '无法连接 QQ 邮箱，请检查邮箱和授权码。');
    }

    const previousEmail = config?.email;
    const startDateChanged = !config || config.email !== nextConfig.email || config.syncStartDate !== nextConfig.syncStartDate;

    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (body.authCode) {
      await secretStore.set(nextConfig.email, authCode);
    }
    await atomicWritePrivateJson(configPath, nextConfig);
    if (previousEmail && previousEmail !== nextConfig.email) {
      await secretStore.delete(previousEmail).catch(() => {});
    }

    config = nextConfig;
    persisted = await loadPersistedState(config);
    if (startDateChanged) {
      // Reset cursor so the next sync covers from the chosen syncStartDate.
      persisted = { ...persisted, uidValidity: null, lastUid: 0, lastError: null, unfilteredBackfillComplete: false };
      await savePersistedState(config, persisted);
    }
    ensureTimer();
    const status = await waitBrieflyForSync(startRegularSync());
    return c.json({ data: status });
  });

  routes.delete('/mail/config', async c => {
    const previous = config;
    clearTimer();
    config = null;
    persisted = { uidValidity: null, lastUid: 0, lastSyncAt: null, lastSuccessAt: null, lastError: null };
    await unlink(configPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    if (previous) {
      await secretStore.delete(previous.email).catch(() => {});
    }
    return c.json({ data: await buildStatus() });
  });

  routes.post('/mail/sync', async c => {
    const raw = await c.req.json().catch(() => ({}));
    const hasRange = raw && typeof raw === 'object' && ('startDate' in raw || 'endDate' in raw);
    const range = hasRange ? syncRangeInputSchema.parse(raw) : undefined;
    return c.json({ data: await waitBrieflyForSync(sync(range)) });
  });

  routes.get('/mail/issues/:uidValidity/:uid', async c => {
    if (!config) throw new ApiError(404, 'MAIL_NOT_CONFIGURED', '尚未配置 QQ 邮箱同步。');
    const uidValidity = Number.parseInt(c.req.param('uidValidity'), 10);
    const uid = Number.parseInt(c.req.param('uid'), 10);
    if (!Number.isInteger(uidValidity) || uidValidity <= 0 || !Number.isInteger(uid) || uid <= 0) {
      throw new ApiError(400, 'INVALID_UID', '无效的邮件标识。');
    }
    const sid = sourceKey(config);
    const row = await db.prepare(`SELECT uid_validity, uid, subject, mail_date, error_message, body_preview
      FROM local_mail_messages
      WHERE source_id=? AND uid_validity=? AND uid=? AND status='invalid'`)
      .bind(sid, uidValidity, uid).first<{
        uid_validity: number; uid: number; subject: string; mail_date: string | null;
        error_message: string | null; body_preview: string | null;
      }>();
    if (!row) throw new ApiError(404, 'MAIL_ISSUE_NOT_FOUND', '这条待处理邮件不存在或已处理。');

    let body = row.body_preview ?? '';
    if (row.body_preview === null && transport.fetchMessage) {
      const authCode = await secretStore.get(config.email);
      if (!authCode) throw new ApiError(422, 'AUTH_CODE_REQUIRED', '系统钥匙串中未找到邮箱授权码，请重新配置邮箱。');
      const fetched = await transport.fetchMessage({
        host: config.host,
        port: config.port,
        email: config.email,
        authCode,
        mailbox: config.mailbox,
      }, uidValidity, uid);
      if (fetched) {
        body = cleanBodyPreview(fetched.email.text);
        await db.prepare(
          "UPDATE local_mail_messages SET body_preview=?,body_complete=? WHERE source_id=? AND uid_validity=? AND uid=? AND status='invalid'",
        ).bind(body, Number(!fetched.decodeError && body === fetched.email.text.trim()), sid, uidValidity, uid).run();
      }
    }

    const detail: MailIssueDetail = {
      uidValidity: row.uid_validity,
      uid: row.uid,
      subject: row.subject || '招商银行邮件',
      mailDate: row.mail_date,
      message: row.error_message || '邮件暂未自动解析，请核对。',
      body: body || '未能读取到邮件正文，请在 QQ 邮箱中查看该时间点的原始邮件。',
      draft: extractMailIssueDraft(body, row.mail_date),
    };
    return c.json({ data: detail });
  });

  routes.post('/mail/issues/:uidValidity/:uid/record', async c => {
    if (!config) throw new ApiError(404, 'MAIL_NOT_CONFIGURED', '尚未配置 QQ 邮箱同步。');
    const uidValidity = Number.parseInt(c.req.param('uidValidity'), 10);
    const uid = Number.parseInt(c.req.param('uid'), 10);
    if (!Number.isInteger(uidValidity) || uidValidity <= 0 || !Number.isInteger(uid) || uid <= 0) {
      throw new ApiError(400, 'INVALID_UID', '无效的邮件标识。');
    }
    const sid = sourceKey(config);
    const existing = await db.prepare(
      "SELECT unmatched_template FROM local_mail_messages WHERE source_id=? AND uid_validity=? AND uid=? AND status='invalid'",
    ).bind(sid, uidValidity, uid).first<{ unmatched_template: string | null }>();
    if (!existing) throw new ApiError(404, 'MAIL_ISSUE_NOT_FOUND', '这条待处理邮件不存在或已处理。');

    const rawBody = await c.req.json();
    const input = normalizeInput(parseInput(transactionInputSchema, {
      ...rawBody,
      accountId: rawBody?.accountId ?? config.accountId,
    }));
    const created = await createTransaction(db, input, {
      source: 'manual',
      ...receipt(config, uidValidity, uid),
    });
    await db.prepare(
      "UPDATE local_mail_messages SET status='imported', transaction_id=?, error_message=NULL, body_preview=NULL, body_complete=0, unmatched_template=NULL, processed_at=? WHERE source_id=? AND uid_validity=? AND uid=?",
    ).bind(created.transaction.id, now().toISOString(), sid, uidValidity, uid).run();

    // Learn this email's action template so remaining and future similar emails are auto-processed
    const tpl = existing.unmatched_template;
    if (tpl) {
      persisted = {
        ...persisted,
        learnedTemplates: {
          ...persisted.learnedTemplates,
          [tpl]: {
            kind: input.kind,
            ...(input.kind === 'transfer' && input.transferDirection ? { transferDirection: input.transferDirection } : {}),
            ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          },
        },
      };
      await savePersistedState(config, persisted);
    }
    const autoResolvedCount = tpl ? await resolvePendingIssues(config, tpl) : 0;
    return c.json({ data: { transaction: created.transaction, autoResolvedCount, status: await buildStatus() } }, 201);
  });

  const issueSourceSchema = z.object({ email: mailConfigSchema.shape.email, accountId: z.string().min(1) });
  function requireIssueSource(body: z.infer<typeof issueSourceSchema>) {
    if (!config) throw new ApiError(404, 'MAIL_NOT_CONFIGURED', '尚未配置 QQ 邮箱同步。');
    if (body.email !== config.email || body.accountId !== config.accountId) {
      throw new ApiError(409, 'MAIL_SOURCE_CHANGED', '邮箱配置已更新，请刷新待核对列表。');
    }
    return sourceKey(config);
  }
  const dismissIssueSql = "UPDATE local_mail_messages SET status='ignored', dismissed_by_user=1 WHERE source_id=? AND uid_validity=? AND uid=? AND status='invalid'";
  routes.post('/mail/issues/dismiss-all', async c => {
    const body = issueSourceSchema.extend({
      issues: z.array(z.object({ uidValidity: z.number().int().positive(), uid: z.number().int().positive() })).min(1).max(50),
    }).parse(await c.req.json());
    const sid = requireIssueSource(body);
    await db.batch(body.issues.map(issue => db.prepare(dismissIssueSql).bind(sid, issue.uidValidity, issue.uid)));
    return c.json({ data: await buildStatus() });
  });
  routes.post('/mail/issues/restore-dismissed', async c => {
    const sid = requireIssueSource(issueSourceSchema.parse(await c.req.json()));
    await db.prepare("UPDATE local_mail_messages SET status='invalid', dismissed_by_user=0 WHERE source_id=? AND dismissed_by_user=1").bind(sid).run();
    return c.json({ data: await buildStatus() });
  });

  routes.post('/mail/issues/:uidValidity/:uid/dismiss', async c => {
    if (!config) throw new ApiError(404, 'MAIL_NOT_CONFIGURED', '尚未配置 QQ 邮箱同步。');
    const uidValidity = Number.parseInt(c.req.param('uidValidity'), 10);
    const uid = Number.parseInt(c.req.param('uid'), 10);
    if (!Number.isInteger(uidValidity) || uidValidity <= 0 || !Number.isInteger(uid) || uid <= 0) {
      throw new ApiError(400, 'INVALID_UID', '无效的邮件标识。');
    }
    await db.prepare(dismissIssueSql).bind(sourceKey(config), uidValidity, uid).run();
    return c.json({ data: await buildStatus() });
  });

  return {
    routes,
    status: buildStatus,
    sync,
    start() {
      if (started) return;
      started = true;
      if (!config) return;
      if (!mutating) void sync().catch(() => {});
      ensureTimer();
    },
    async stop() {
      started = false;
      clearTimer();
      await inFlight;
    },
  };
}
