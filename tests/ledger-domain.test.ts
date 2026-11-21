import { describe, expect, it } from 'vitest';
import { currentMonth, elapsedMonthDays, monthBounds, normalizeDate, parseAmount, parseCmb } from '../src/server/ledger/domain';

describe('账本金金额和时间契约', () => {
  it('金额从十进制文本准确转为分，不发生二进制舍入', () => {
    expect(parseAmount('0.29')).toBe(29);
    expect(parseAmount('12345678.91')).toBe(1234567891);
    expect(parseAmount('12.3')).toBe(1230);
  });
  it.each(['0', '-1', '1.001', '1e3', 'Infinity', '1,000.00', '01.00', '10000000000'])('拒绝不明确或超范围金额 %s', (amount) => {
    expect(() => parseAmount(amount)).toThrow();
  });
  it('明确北京时间月边界，支持闰年和跨年', () => {
    expect(monthBounds('2026-01')).toEqual({
      start: '2025-12-31T16:00:00.000Z', end: '2026-01-31T16:00:00.000Z',
      previousStart: '2025-11-30T16:00:00.000Z', previousMonth: '2025-12',
    });
    const leap = monthBounds('2028-02');
    expect((Date.parse(leap.end) - Date.parse(leap.start)) / 86400000).toBe(29);
    expect(currentMonth(new Date('2026-10-31T16:00:00Z'))).toBe('2026-11');
  });
  it('本月日均包含今天，分母在北京时间午夜递增', () => {
    expect(elapsedMonthDays('2026-11', new Date('2026-11-02T15:59:59Z'))).toBe(2);
    expect(elapsedMonthDays('2026-11', new Date('2026-11-02T16:00:00Z'))).toBe(3);
    expect(elapsedMonthDays('2026-11', new Date('2026-10-31T16:00:00Z'))).toBe(1);
  });
  it('月末和跨年使用北京日历，历史月按完整天数，未来月尚无已发生天数', () => {
    const beforeDecember = new Date('2026-11-30T15:59:59Z');
    const startDecember = new Date('2026-11-30T16:00:00Z');
    expect(elapsedMonthDays('2026-11', beforeDecember)).toBe(30);
    expect(elapsedMonthDays('2026-12', beforeDecember)).toBe(0);
    expect(elapsedMonthDays('2026-11', startDecember)).toBe(30);
    expect(elapsedMonthDays('2026-12', startDecember)).toBe(1);
    const newYear = new Date('2026-12-31T16:00:00Z');
    expect(elapsedMonthDays('2026-12', newYear)).toBe(31);
    expect(elapsedMonthDays('2027-01', newYear)).toBe(1);
    expect(elapsedMonthDays('2027-02', newYear)).toBe(0);
  });
  it('二月按平年与闰年实际日历计算，不按固定30天', () => {
    expect(elapsedMonthDays('2027-02', new Date('2027-03-01T00:00:00+08:00'))).toBe(28);
    expect(elapsedMonthDays('2028-02', new Date('2028-03-01T00:00:00+08:00'))).toBe(29);
    expect(elapsedMonthDays('2028-02', new Date('2028-02-29T12:00:00+08:00'))).toBe(29);
  });
  it('要求完整日期和时区，不自动补年份或校正错误日期', () => {
    expect(normalizeDate('2026-11-01T08:09:10+08:00')).toBe('2026-11-01T00:09:10.000Z');
    for (const value of ['2026-02-30T00:00:00+08:00', '11-01 08:09', '2026-11-01T08:09:10', '2026-11-01T25:00:00Z']) {
      expect(() => normalizeDate(value)).toThrow();
    }
  });
});

describe('招行适配边界', () => {
  const payload = {
    amount: '52.10', transaction_time: '2026-11-01T09:05:00+08:00',
    transaction_type: 'purchase', direction: 'outflow', description: '测试交易', counterparty: '测试商户',
    transaction_fingerprint: 'test-fingerprint', currency: 'CNY', bank: '招商银行', parser_version: '1.1.4',
  };
  it('保持金额、时间和绑定账户，提现不计收入', () => {
    const result = parseCmb(payload, 'account-a');
    expect(result.transaction).toMatchObject({ amountCents: 5210, kind: 'expense', accountId: 'account-a', occurredAt: '2026-11-01T01:05:00.000Z' });
    expect(parseCmb({ ...payload, transaction_type: 'wallet_withdrawal', direction: 'inflow' }, 'account-a').transaction.kind).toBe('transfer');
  });
  it('未知类型、方向冲突、非人民币都显式失败', () => {
    expect(() => parseCmb({ ...payload, transaction_type: '未知交易' }, 'account-a')).toThrow();
    expect(() => parseCmb({ ...payload, direction: 'inflow' }, 'account-a')).toThrow();
    expect(() => parseCmb({ ...payload, currency: 'USD' }, 'account-a')).toThrow();
  });
  it('未知性质的其他入账须核对后才计收入', () => {
    const parsed = parseCmb({ ...payload, transaction_type: 'credit', direction: 'inflow' }, 'account-a');
    expect(parsed.needsReview).toBe(true);
    expect(parsed.transaction.kind).toBe('income');
    expect(parsed.transaction.note).toContain('请确认');
  });
  it.each(['微信零钱提现', '微信零钱提现／微信零钱提现。', '财付通-测试姓名-微信零钱提现', ' 财付通－另一个名字－微信零钱提现。 '])('明确的钱包提现不计收入，保留原始摘要与来源类型：%s', (description) => {
    const parsed = parseCmb({ ...payload, transaction_type: 'credit', direction: 'inflow', description, counterparty: '' }, 'account-a');
    expect(parsed.transaction).toMatchObject({ kind: 'transfer', description: description.trim(), counterparty: '', note: '' });
    expect(parsed.needsReview).toBe(false);
    expect(parsed.sourceDetails.transactionType).toBe('credit');
    expect(parsed.fingerprint).toBe(payload.transaction_fingerprint);
  });
  it.each(['财付通-测试姓名-微信零钱提现失败退款', '财付通-测试姓名-微信零钱提现手续费退还', '微信零钱提现退款', '朋友还款备注：微信零钱提现', '财付通-测试姓名-转账', '财付通-测试姓名-退款-微信零钱提现', '财付通- -微信零钱提现', '某平台提现'])('摘要不明确的其他入账仍需核对：%s', (description) => {
    const parsed = parseCmb({ ...payload, transaction_type: 'credit', direction: 'inflow', description }, 'account-a');
    expect(parsed.transaction.kind).toBe('income');
    expect(parsed.needsReview).toBe(true);
  });
  it('提现摘要不覆盖明确的退款类型，方向不符仍报错', () => {
    const description = '财付通-测试姓名-微信零钱提现';
    expect(parseCmb({ ...payload, transaction_type: 'refund', direction: 'inflow', description }, 'account-a').transaction.kind).toBe('refund');
    expect(() => parseCmb({ ...payload, transaction_type: 'credit', direction: 'outflow', description }, 'account-a')).toThrow();
  });
  it('保留原始方向、类型、解析版本和十进制余额，拒绝畸形余额', () => {
    const parsed = parseCmb({ ...payload, balance: '15230.19', transaction_time_raw: '11月1日09:05' }, 'account-a');
    expect(parsed.sourceDetails).toEqual({ transactionType: 'purchase', direction: 'outflow', parserVersion: '1.1.4', balance: '15230.19', transactionTimeRaw: '11月1日09:05' });
    expect(parseCmb({ ...payload, balance: '-0.15' }, 'account-a').sourceDetails.balance).toBe('-0.15');
    expect(() => parseCmb({ ...payload, balance: '12.123' }, 'account-a')).toThrow();
  });
});
