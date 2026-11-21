import { parseCmb } from './domain';

export const CMB_EMAIL_PARSER_VERSION = '1.1.5';

interface ParserRule {
  pattern: RegExp;
  direction: 'inflow' | 'outflow';
  type: 'purchase' | 'refund' | 'transfer_out' | 'transfer_in' | 'salary' | 'wallet_withdrawal' | 'credit';
  partyGroup: number;
  descriptionGroup: number;
  amountGroup: number;
  balanceGroup: number;
}

const TRANSACTION_START_PATTERN = /您(?:的)?账户\s*[0-9]+\s*于/g;

// Ported faithfully from integrations/shortcuts/src/cmb-parser.plist (1.1.5)
// so SHA-256 fingerprints stay bit-for-bit identical with historical Feishu/Shortcut imports.
const RULES: ParserRule[] = [
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*在\s*((?:(?!您(?:的)?账户)[\s\S])+?)\s*快捷支付\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])/,
    direction: 'outflow', type: 'purchase', partyGroup: 2, descriptionGroup: 2, amountGroup: 3, balanceGroup: 4,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*在\s*((?:(?!您(?:的)?账户)[\s\S])+?)\s*退款\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])/,
    direction: 'inflow', type: 'refund', partyGroup: 2, descriptionGroup: 2, amountGroup: 3, balanceGroup: 4,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*(实时转至他行)\s*人民币\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:元)?\s*[，,]\s*余额\s*(?:人民币\s*)?(-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*[，,]\s*收款人\s*([^\r\n，,。]+)/,
    direction: 'outflow', type: 'transfer_out', partyGroup: 5, descriptionGroup: 2, amountGroup: 3, balanceGroup: 4,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*(入账工资)\s*[，,]\s*人民币\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:元)?\s*[，,]\s*余额\s*(?:人民币\s*)?(-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])/,
    direction: 'inflow', type: 'salary', partyGroup: 0, descriptionGroup: 2, amountGroup: 3, balanceGroup: 4,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*入账\s*(?:人民币\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?[（(](?=\s*微信零钱提现(?:\s*[/／]\s*[^（）()\r\n]+)?\s*[）)])(?!\s*[）)])((?:(?!您(?:的)?账户)[^（）()\r\n])+?)\s*[）)]/,
    direction: 'inflow', type: 'wallet_withdrawal', partyGroup: 0, descriptionGroup: 4, amountGroup: 2, balanceGroup: 3,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*入账\s*(?:人民币\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?[（(](?!\s*微信零钱提现(?:\s*[/／]\s*[^（）()\r\n]+)?\s*[）)])(?!\s*[）)])((?:(?!您(?:的)?账户)[^（）()\r\n])+?)\s*[）)]/,
    direction: 'inflow', type: 'credit', partyGroup: 0, descriptionGroup: 4, amountGroup: 2, balanceGroup: 3,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*收款\s*(?:人民币\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?[（(](?!\s*[）)])((?:(?!您(?:的)?账户)[^（）()\r\n])+?)\s*[）)]/,
    direction: 'inflow', type: 'credit', partyGroup: 0, descriptionGroup: 4, amountGroup: 2, balanceGroup: 3,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*(?:收款|入账)\s*(?:人民币\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?[，,]\s*备注\s*[:：][ \t]*(?![ \t]*[。.]?[ \t]*(?:\r?\n|$))((?:(?!您(?:的)?账户)[^\r\n])+?)[ \t]*(?=\r?\n|$)/,
    direction: 'inflow', type: 'credit', partyGroup: 0, descriptionGroup: 4, amountGroup: 2, balanceGroup: 3,
  },
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])\s*(收款|入账)\s*(?:人民币\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*元\s*[，,]\s*余额\s*(?:人民币\s*)?(-?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?(?:[，,][ \t]*备注[ \t]*[:：][ \t]*)?[ \t]*[。.]?[ \t]*(?!\s*(?:元\s*)?(?:[（(]|[，,]\s*备注\s*[:：]))(?=\r?\n|$)/,
    direction: 'inflow', type: 'credit', partyGroup: 0, descriptionGroup: 2, amountGroup: 3, balanceGroup: 4,
  },
];

// Additional CMB notification templates (evaluated only when the 1.1.5 rules above do not match).
const EXTENDED_RULES: ParserRule[] = [
  // 银联扣款 / 网上支付 / 协议扣款 / 代扣（括号内可含嵌套括号，如“（银联在线支付，（特约）美团）”）
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日(?:\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])?)\s*(?:银联扣款|银联消费|网上支付|协议扣款|自动扣款|代扣)\s*(?:人民币\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:元)?\s*[，,]\s*余额\s*(?:人民币\s*)?(-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?[（(](?!\s*[）)])((?:(?!您(?:的)?账户)[^（）()\r\n]|[（(][^（）()\r\n]*[）)])+)\s*[）)]/,
    direction: 'outflow', type: 'purchase', partyGroup: 4, descriptionGroup: 4, amountGroup: 2, balanceGroup: 3,
  },
  // 收到本行转入 / 他行实时转入 / 他行转入 / 本行转入（时间可仅含月日，金额后可省“元”，可带“付方…”、“备注：…”）
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日(?:\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])?)\s*(收到本行转入|收到他行转入|他行实时转入|本行实时转入|他行转入|本行转入|他行汇入)\s*(?:人民币\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:元)?\s*[，,]\s*余额\s*(?:人民币\s*)?(-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元)?(?:\s*[，,]\s*付方\s*([^\r\n，,。]+))?(?:\s*[，,]\s*备注\s*[:：]\s*([^\r\n。]+))?/,
    direction: 'inflow', type: 'transfer_in', partyGroup: 5, descriptionGroup: 2, amountGroup: 3, balanceGroup: 4,
  },
  // 入账 / 收款 括号内含嵌套括号（如“（特约）商户”）
  {
    pattern: /您(?:的)?账户\s*[0-9]+\s*于\s*((?:0?[1-9]|1[0-2])月\s*(?:0?[1-9]|[12][0-9]|3[01])日(?:\s*(?:[01]?[0-9]|2[0-3])[:：][0-5][0-9])?)\s*(?:收款|入账)\s*(?:人民币\s*)?((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)\s*(?:元)?\s*[，,]\s*余额\s*(?:人民币\s*)?(-?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9]|[.,][0-9])\s*(?:元\s*)?[（(](?!\s*[）)])((?:(?!您(?:的)?账户)[^（）()\r\n]|[（(][^（）()\r\n]*[）)])+)\s*[）)]/,
    direction: 'inflow', type: 'credit', partyGroup: 0, descriptionGroup: 4, amountGroup: 2, balanceGroup: 3,
  },
];

const WECHAT_TOPUP_PARTY = /(?:^|[-－])\s*微信零钱充值账户\s*$/;
const WECHAT_WITHDRAWAL_DESC = /^\s*微信零钱提现(?:\s*[/／]\s*微信零钱提现)*\s*[。.]?\s*$/;
const ALIPAY_WITHDRAWAL_DESC = /^\s*(?:支付宝[-－][^\r\n]*)?支付宝余额提现(?:\s*[/／]\s*支付宝余额提现)*\s*[。.]?\s*$/;
const NORMALIZABLE_TRANSFER_TYPE = /^(?:purchase|refund|credit|transfer_out)$/;
const WECHAT_TRANSFER_DESC = /^\s*(?:财付通\s*[-－]\s*微信支付\s*[-－]\s*)?微信转账\s*[。．.]?\s*$/;
const VALID_GREGORIAN_ISO = /^(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)T(?:[01][0-9]|2[0-3]):[0-5][0-9]:00\+08:00$/;

export interface CmbEmailPayload {
  amount: string;
  balance: string;
  transaction_time: string;
  transaction_time_raw: string;
  transaction_type: string;
  direction: 'inflow' | 'outflow';
  description: string;
  counterparty: string;
  bank: '招商银行';
  currency: 'CNY';
  parser_version: string;
  transaction_fingerprint: string;
}

export type CmbEmailParseResult =
  | { status: 'not_transaction' }
  | { status: 'ambiguous' | 'unmatched' | 'invalid_date'; message: string }
  | { status: 'parsed'; payload: CmbEmailPayload; parsed: ReturnType<typeof parseCmb> };

/** Pre-filter email headers before downloading full message bodies. */
export function isLikelyCmbEmailHeader(from: string, subject: string): boolean {
  const combinedFrom = from.toLowerCase();
  if (combinedFrom.includes('cmbchina.com') || from.includes('招商银行')) return true;
  return /招商银行|招行|一卡通|动账|账户变动|交易通知|交易提醒/.test(subject);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function shanghaiYearMonth(date: Date): { year: number; month: number } {
  const shanghai = new Date(date.valueOf() + 8 * 60 * 60 * 1000);
  return { year: shanghai.getUTCFullYear(), month: shanghai.getUTCMonth() + 1 };
}

function resolveTransactionYear(txMonth: number, referenceDate: Date): number {
  const { year, month } = shanghaiYearMonth(referenceDate);
  if (txMonth === 12 && month === 1) return year - 1;
  if (txMonth === 1 && month === 12) return year + 1;
  return year;
}

export async function parseCmbEmailBody(
  body: string,
  accountId: string,
  referenceDate: Date = new Date(),
): Promise<CmbEmailParseResult> {
  const text = body.replace(/\r\n/g, '\n');
  const starts = text.match(TRANSACTION_START_PATTERN);
  if (!starts || starts.length === 0) return { status: 'not_transaction' };
  if (starts.length > 1) {
    return { status: 'ambiguous', message: '邮件正文包含多条交易或引用内容，未自动入账，请核对邮件。' };
  }

  const matched: { rule: ParserRule; match: RegExpExecArray }[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) matched.push({ rule, match });
  }
  if (matched.length === 0) {
    for (const rule of EXTENDED_RULES) {
      const match = rule.pattern.exec(text);
      if (match) matched.push({ rule, match });
    }
  }
  if (matched.length === 0) {
    return { status: 'unmatched', message: '检测到招商银行动账邮件，但暂未匹配到已知交易格式，请核对。' };
  }
  if (matched.length > 1) {
    return { status: 'ambiguous', message: '邮件正文同时匹配到多条解析规则，未自动入账，请核对。' };
  }

  const { rule, match } = matched[0];
  const rawTime = match[1].replace(/\s+/g, '').replaceAll('：', ':');
  const rawDescription = match[rule.descriptionGroup].trim();
  const amount = match[rule.amountGroup].replaceAll(',', '');
  const balance = match[rule.balanceGroup].replaceAll(',', '');
  const rawParty = rule.partyGroup > 0 ? (match[rule.partyGroup] ?? '').trim() : '';
  const description = rule.type === 'transfer_in' && rawParty && !rawDescription.includes(rawParty)
    ? `${rawDescription} - ${rawParty}`
    : rawDescription;

  // Compute SHA-256 fingerprint using original 1.1.1-compatible pre-normalization fields.
  const fingerprintSource = `招商银行\nCNY\n${rawTime}\n${rule.type}\n${rawParty}\n${amount}\n${balance}`;
  const fingerprint = await sha256Hex(fingerprintSource);

  let normalizedParty = rawParty;
  let normalizedType: string = rule.type;

  if (normalizedType === 'wallet_withdrawal') {
    normalizedParty = '微信零钱';
  }
  if (normalizedType === 'purchase' && WECHAT_TOPUP_PARTY.test(rawParty)) {
    normalizedType = 'wallet_topup';
  }
  if (normalizedType === 'credit') {
    if (WECHAT_WITHDRAWAL_DESC.test(description)) {
      normalizedType = 'wallet_withdrawal';
      normalizedParty = '微信零钱';
    } else if (ALIPAY_WITHDRAWAL_DESC.test(description)) {
      normalizedType = 'wallet_withdrawal';
      normalizedParty = '支付宝余额';
    }
  }
  if (NORMALIZABLE_TRANSFER_TYPE.test(normalizedType) && WECHAT_TRANSFER_DESC.test(description)) {
    normalizedType = rule.direction === 'inflow' ? 'transfer_in' : 'transfer_out';
  }

  const paddedTime = rawTime
    .replace(/^([0-9])月/, '0$1月')
    .replace(/月([0-9])日/, '月0$1日')
    .replace(/日([0-9]):/, '日0$1:');
  let isoMatch = /^([0-9]{2})月([0-9]{2})日([0-9]{2}):([0-9]{2})$/.exec(paddedTime);
  if (!isoMatch) {
    const dateOnlyMatch = /^([0-9]{2})月([0-9]{2})日$/.exec(paddedTime);
    if (dateOnlyMatch && Number.isFinite(referenceDate.valueOf())) {
      const shanghaiIso = new Date(referenceDate.valueOf() + 8 * 60 * 60 * 1000).toISOString();
      const hh = shanghaiIso.slice(11, 13);
      const mm = shanghaiIso.slice(14, 16);
      isoMatch = [`${paddedTime}${hh}:${mm}`, dateOnlyMatch[1], dateOnlyMatch[2], hh, mm] as unknown as RegExpExecArray;
    }
  }
  if (!isoMatch) {
    return { status: 'invalid_date', message: `交易时间格式异常（${rawTime}），未自动入账。` };
  }
  const [, monthStr, dayStr, hourStr, minuteStr] = isoMatch;
  const year = resolveTransactionYear(Number(monthStr), referenceDate);
  const fullIso = `${year}-${monthStr}-${dayStr}T${hourStr}:${minuteStr}:00+08:00`;
  if (!VALID_GREGORIAN_ISO.test(fullIso)) {
    return { status: 'invalid_date', message: `交易日期 ${year}-${monthStr}-${dayStr} 无效，未自动入账。` };
  }

  const payload: CmbEmailPayload = {
    amount,
    balance,
    transaction_time: fullIso,
    transaction_time_raw: rawTime,
    transaction_type: normalizedType,
    direction: rule.direction,
    description,
    counterparty: normalizedParty,
    bank: '招商银行',
    currency: 'CNY',
    parser_version: CMB_EMAIL_PARSER_VERSION,
    transaction_fingerprint: fingerprint,
  };

  try {
    const parsed = parseCmb(payload, accountId);
    return { status: 'parsed', payload, parsed };
  } catch (error) {
    return {
      status: 'unmatched',
      message: error instanceof Error ? `账单校验未通过：${error.message}` : '账单校验未通过，请核对邮件。',
    };
  }
}
