import { z } from 'zod';
import type { SourceDetails, TransactionInput, TransactionKind } from '../../shared/contracts';
import { TRANSACTION_KINDS } from '../../shared/contracts';
import { ApiError, invalid } from '../errors';

export const MAX_CENTS = 999_999_999_999;
export const textId = z.string().min(1).max(100);
const boundedText = (max: number) => z.string().trim().max(max);

export const transactionInputSchema = z.object({
  occurredAt: z.string().max(40),
  kind: z.enum(TRANSACTION_KINDS),
  amount: z.string().trim().max(20),
  description: boundedText(300).min(1, '请填写交易描述'),
  counterparty: boundedText(200).optional().default(''),
  categoryId: textId.nullable().optional().default(null),
  accountId: textId,
  note: boundedText(2000).optional().default(''),
  isFixed: z.boolean().optional(),
  categoryOverride: z.boolean().optional(),
  transferDirection: z.enum(['inflow', 'outflow']).optional(),
});

export const versionSchema = z.object({ version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
export const updateSchema = transactionInputSchema.extend({
  version: versionSchema.shape.version,
  reviewStatus: z.enum(['confirmed', 'pending']).optional(),
});

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalid(result.error.issues.map((issue) => `${issue.path.join('.') || '输入'}：${issue.message}`).join('；'));
  return result.data;
}

/** Decimal text to integer cents, without passing through floating point. */
export function parseAmount(value: string): number {
  const clean = value.trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(clean)) invalid('金额须为正数，最多两位小数，不含千位分隔符');
  const [yuan, fraction = ''] = clean.split('.');
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0 || cents > MAX_CENTS || !Number.isSafeInteger(cents)) invalid('金额超出允许范围');
  return cents;
}

/** Require an explicit offset and reject JavaScript's rollover of impossible dates. */
export function normalizeDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) invalid('交易时间须包含年月日、时分秒和时区');
  const [, year, month, day, hour, minute, second, , , , zoneHour, zoneMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const maxDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (y < 1970 || y > 2199 || m < 1 || m > 12 || d < 1 || d > maxDay || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(zoneHour || 0) > 14 || Number(zoneMinute || 0) > 59 || (Number(zoneHour) === 14 && Number(zoneMinute) !== 0)) {
    invalid('交易时间不是有效日期');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) invalid('交易时间不是有效日期');
  return date.toISOString();
}

export function validateMonth(value: string): string {
  if (!/^(?:19[7-9]\d|20\d{2}|21\d{2})-(?:0[1-9]|1[0-2])$/.test(value)) invalid('月份格式应为 YYYY-MM');
  return value;
}

export function currentMonth(now = new Date()): string {
  return new Date(now.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/** Calendar days elapsed in the selected month, including today in Beijing time. */
export function elapsedMonthDays(month: string, now = new Date()): number {
  validateMonth(month);
  const current = currentMonth(now);
  if (month > current) return 0;
  if (month === current) return new Date(now.valueOf() + 8 * 60 * 60 * 1000).getUTCDate();
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

export function monthBounds(month: string): { start: string; end: string; previousMonth: string; previousStart: string } {
  validateMonth(month);
  const [year, number] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, number - 1, 1, -8)).toISOString();
  const end = new Date(Date.UTC(year, number, 1, -8)).toISOString();
  const previousStart = new Date(Date.UTC(year, number - 2, 1, -8)).toISOString();
  const previousMonth = new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
  return { start, end, previousStart, previousMonth };
}

export function idempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8 至 160 字符的 Idempotency-Key，重试时沿用同一个值');
  }
  return value;
}

export async function hashPayload(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface NormalizedInput {
  occurredAt: string; kind: TransactionKind; amountCents: number; description: string;
  counterparty: string; categoryId: string | null; accountId: string; note: string; isFixed?: boolean; categoryOverride?: boolean; transferDirection?: 'inflow' | 'outflow';
}

export function normalizeInput(value: TransactionInput): NormalizedInput {
  const parsed = parseInput(transactionInputSchema, value);
  if (parsed.isFixed && parsed.kind !== 'expense') invalid('只有支出可以标记为固定支出');
  if (parsed.transferDirection !== undefined && parsed.kind !== 'transfer') invalid('只有转账可以设置资金方向');
  return {
    occurredAt: normalizeDate(parsed.occurredAt), kind: parsed.kind, amountCents: parseAmount(parsed.amount),
    description: parsed.description, counterparty: parsed.counterparty,
    categoryId: parsed.categoryId, accountId: parsed.accountId, note: parsed.note,
    ...(parsed.isFixed === undefined ? {} : { isFixed: parsed.isFixed }),
    ...(parsed.categoryOverride === undefined ? {} : { categoryOverride: parsed.categoryOverride }),
    ...(parsed.transferDirection === undefined ? {} : { transferDirection: parsed.transferDirection }),
  };
}

const cmbSchema = z.object({
  amount: z.string().max(20), transaction_time: z.string().max(40),
  transaction_type: boundedText(40).min(1), direction: boundedText(20).min(1),
  description: boundedText(300).min(1), counterparty: boundedText(200).optional().default(''),
  transaction_fingerprint: boundedText(1000).min(1),
  currency: z.literal('CNY'), bank: z.literal('招商银行'),
  parser_version: boundedText(40).min(1),
  transaction_time_raw: boundedText(100).optional(),
  balance: z.string().trim().regex(/^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, '余额须为最多两位小数的十进制文本').optional(),
});

// The adapter accepts only the documented bank parser vocabulary. Unknown values are visible errors.
const cmbKinds: Record<string, { kind: TransactionKind; direction: 'inflow' | 'outflow' }> = {
  purchase: { kind: 'expense', direction: 'outflow' },
  refund: { kind: 'refund', direction: 'inflow' },
  transfer_out: { kind: 'transfer', direction: 'outflow' },
  transfer_in: { kind: 'transfer', direction: 'inflow' },
  salary: { kind: 'income', direction: 'inflow' },
  credit: { kind: 'income', direction: 'inflow' },
  wallet_withdrawal: { kind: 'transfer', direction: 'inflow' },
  wallet_topup: { kind: 'transfer', direction: 'outflow' },
};

// Older phone parsers can label these explicit wallet movements as a generic
// credit. Keep the original source type and identify the movement as a transfer.
const wechatWithdrawalDescription = /^\s*(?:财付通\s*[-－]\s*[^-－\s,，;；][^-－\r\n,，;；]*\s*[-－]\s*)?微信零钱提现(?:\s*[/／]\s*微信零钱提现)*\s*[。.]?\s*$/u;

/** Recognize the payment channel's complete transfer label, excluding refund/failure descriptions. */
export function isExplicitWechatTransfer(description: string, details: SourceDetails | null): boolean {
  if (!details || !['purchase', 'refund', 'credit', 'transfer_out'].includes(details.transactionType)) return false;
  const expectedDirection = details.transactionType === 'purchase' || details.transactionType === 'transfer_out' ? 'outflow' : 'inflow';
  if (details.direction !== expectedDirection) return false;
  const normalized = description.normalize('NFKC').trim();
  return /^(?:财付通\s*[-－]\s*微信支付\s*[-－]\s*)?微信转账\s*[。.]?$/u.test(normalized);
}

export function parseCmb(input: unknown, accountId: string): { transaction: NormalizedInput; fingerprint: string; needsReview: boolean; sourceDetails: SourceDetails } {
  const parsed = parseInput(cmbSchema, input);
  const mapping = cmbKinds[parsed.transaction_type];
  if (!mapping) invalid(`未识别的招行交易类型：${parsed.transaction_type}`);
  if (parsed.direction !== mapping.direction) invalid('交易类型与收支方向不一致');
  const explicitWalletWithdrawal = parsed.transaction_type === 'credit' && wechatWithdrawalDescription.test(parsed.description);
  const needsReview = parsed.transaction_type === 'credit' && !explicitWalletWithdrawal;
  return {
    transaction: normalizeInput({
      occurredAt: parsed.transaction_time, kind: explicitWalletWithdrawal ? 'transfer' : mapping.kind, amount: parsed.amount,
      description: parsed.description, counterparty: parsed.counterparty, accountId,
      categoryId: null, note: needsReview ? '其他入账，请确认是否属于收入。' : '',
    }),
    fingerprint: parsed.transaction_fingerprint,
    needsReview,
    sourceDetails: {
      transactionType: parsed.transaction_type, direction: mapping.direction, parserVersion: parsed.parser_version,
      ...(parsed.transaction_time_raw === undefined ? {} : { transactionTimeRaw: parsed.transaction_time_raw }),
      ...(parsed.balance === undefined ? {} : { balance: parsed.balance }),
    },
  };
}
