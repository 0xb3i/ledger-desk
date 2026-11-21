import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isLikelyCmbEmailHeader, parseCmbEmailBody } from '../src/server/ledger/cmb-email-parser';

function expectedFingerprint(rawTime: string, rawType: string, rawParty: string, amount: string, balance: string): string {
  return createHash('sha256').update(`招商银行\nCNY\n${rawTime}\n${rawType}\n${rawParty}\n${amount}\n${balance}`).digest('hex');
}

describe('招行邮件解析器（1.1.5 规则对齐）', () => {
  it('识别招行发件人与主题头，忽略无关邮件', () => {
    expect(isLikelyCmbEmailHeader('招商银行 <95555@cmbchina.com>', '账户变动通知')).toBe(true);
    expect(isLikelyCmbEmailHeader('notify@other.com', '招商银行一卡通动账提醒')).toBe(true);
    expect(isLikelyCmbEmailHeader('friend@qq.com', '周末一起吃饭')).toBe(false);
  });

  it('解析快捷支付消费并生成与 1.1.5 快捷指令完全一致的 SHA-256 指纹', async () => {
    const body = '您账户1234于11月02日09:15在财付通-美团点评快捷支付35.80元，余额1,234.56。';
    const result = await parseCmbEmailBody(body, 'cmb-default', new Date('2026-11-02T01:16:00Z'));
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.payload).toMatchObject({
      amount: '35.80',
      balance: '1234.56',
      transaction_time: '2026-11-02T09:15:00+08:00',
      transaction_type: 'purchase',
      direction: 'outflow',
      description: '财付通-美团点评',
      counterparty: '财付通-美团点评',
      transaction_fingerprint: expectedFingerprint('11月02日09:15', 'purchase', '财付通-美团点评', '35.80', '1234.56'),
    });
    expect(result.parsed.transaction.amountCents).toBe(3580);
    expect(result.parsed.transaction.kind).toBe('expense');
  });

  it('跨年邮件按邮件头时间自动修正年份（12月31日消费于次年1月1日收到）', async () => {
    const body = '您账户1234于12月31日23:58在支付宝-便利店快捷支付12.00元，余额998.00。';
    const result = await parseCmbEmailBody(body, 'cmb-default', new Date('2027-01-01T00:01:00+08:00'));
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.payload.transaction_time).toBe('2026-12-31T23:58:00+08:00');
  });

  it('支持退款、跨行转出、工资、零钱充值、微信/支付宝提现与微信转账标准化（指纹保持原语义）', async () => {
    const ref = new Date('2026-11-05T12:00:00+08:00');

    const refund = await parseCmbEmailBody('您账户1234于11月05日10:00在支付宝-淘宝退款88.50元，余额1088.50。', 'cmb-default', ref);
    expect(refund.status === 'parsed' && refund.parsed.transaction.kind).toBe('refund');

    const transferOut = await parseCmbEmailBody('您账户1234于11月05日11:00实时转至他行人民币500.00元，余额588.50，收款人张三。', 'cmb-default', ref);
    expect(transferOut.status).toBe('parsed');
    if (transferOut.status === 'parsed') {
      expect(transferOut.payload.transaction_type).toBe('transfer_out');
      expect(transferOut.payload.counterparty).toBe('张三');
    }

    const salary = await parseCmbEmailBody('您账户1234于11月05日12:00入账工资，人民币10,000.00元，余额10,588.50。', 'cmb-default', ref);
    expect(salary.status === 'parsed' && salary.parsed.transaction.kind).toBe('income');

    const topup = await parseCmbEmailBody('您账户1234于11月05日13:00在财付通-微信零钱充值账户快捷支付200.00元，余额10388.50。', 'cmb-default', ref);
    expect(topup.status).toBe('parsed');
    if (topup.status === 'parsed') {
      expect(topup.payload.transaction_type).toBe('wallet_topup');
      expect(topup.payload.transaction_fingerprint).toBe(
        expectedFingerprint('11月05日13:00', 'purchase', '财付通-微信零钱充值账户', '200.00', '10388.50'),
      );
    }

    const wxWithdraw = await parseCmbEmailBody('您账户1234于11月05日14:00入账150.00元，余额10538.50（微信零钱提现）', 'cmb-default', ref);
    expect(wxWithdraw.status).toBe('parsed');
    if (wxWithdraw.status === 'parsed') {
      expect(wxWithdraw.payload.transaction_type).toBe('wallet_withdrawal');
      expect(wxWithdraw.payload.counterparty).toBe('微信零钱');
    }

    const alipayWithdraw = await parseCmbEmailBody('您账户1234于11月05日14:30收款99.00元，余额10637.50，备注：支付宝-支付宝余额提现', 'cmb-default', ref);
    expect(alipayWithdraw.status).toBe('parsed');
    if (alipayWithdraw.status === 'parsed') {
      expect(alipayWithdraw.payload.transaction_type).toBe('wallet_withdrawal');
      expect(alipayWithdraw.payload.counterparty).toBe('支付宝余额');
      expect(alipayWithdraw.payload.transaction_fingerprint).toBe(
        expectedFingerprint('11月05日14:30', 'credit', '', '99.00', '10637.50'),
      );
    }

    const wxTransferIn = await parseCmbEmailBody('您账户1234于11月05日15:00收款188.00元，余额10825.50（财付通-微信支付-微信转账）', 'cmb-default', ref);
    expect(wxTransferIn.status).toBe('parsed');
    if (wxTransferIn.status === 'parsed') {
      expect(wxTransferIn.payload.transaction_type).toBe('transfer_in');
      expect(wxTransferIn.payload.transaction_fingerprint).toBe(
        expectedFingerprint('11月05日15:00', 'credit', '', '188.00', '10825.50'),
      );
    }

    // CMB formats received WeChat transfers as "在财付通-微信支付-微信转账退款...", which 1.1.5 normalizes to transfer_in.
    const wxTransferViaRefundWord = await parseCmbEmailBody('您账户1234于11月05日15:02在财付通-微信支付-微信转账退款188.00元，余额11013.50。', 'cmb-default', ref);
    expect(wxTransferViaRefundWord.status === 'parsed' && wxTransferViaRefundWord.payload.transaction_type).toBe('transfer_in');

    // Genuine transfer failure/fee refund keeps refund type.
    const wxTransferFailureRefund = await parseCmbEmailBody('您账户1234于11月05日15:05在财付通-微信支付-微信转账失败退款188.00元，余额11201.50。', 'cmb-default', ref);
    expect(wxTransferFailureRefund.status === 'parsed' && wxTransferFailureRefund.payload.transaction_type).toBe('refund');

    // UnionPay deduction with nested parentheses in merchant description
    const unionPay = await parseCmbEmailBody('您账户0000于10月21日18:50银联扣款人民币18.80元，余额1068.86元（银联在线支付，（特约）示例商户）（温馨提示：请留意余额）', 'cmb-default', ref);
    expect(unionPay.status).toBe('parsed');
    if (unionPay.status === 'parsed') {
      expect(unionPay.payload.transaction_type).toBe('purchase');
      expect(unionPay.payload.description).toBe('银联在线支付，（特约）示例商户');
      expect(unionPay.parsed.transaction.amountCents).toBe(1880);
    }

    // Intra/inter-bank transfer-in without HH:mm timestamp
    const bankTransferIn = await parseCmbEmailBody('您账户0000于02月07日收到本行转入人民币200.00，余额1284.95，付方测试用户甲（0000），备注：转账', 'cmb-default', new Date('2026-02-07T02:38:49.000Z'));
    expect(bankTransferIn.status).toBe('parsed');
    if (bankTransferIn.status === 'parsed') {
      expect(bankTransferIn.payload.transaction_type).toBe('transfer_in');
      expect(bankTransferIn.payload.counterparty).toBe('测试用户甲（0000）');
      expect(bankTransferIn.payload.description).toBe('收到本行转入 - 测试用户甲（0000）');
      expect(bankTransferIn.parsed.transaction.amountCents).toBe(20000);
    }
  });

  it('区分非交易邮件、多交易引用邮件、未匹配格式与无效日期', async () => {
    const ref = new Date('2026-11-05T12:00:00+08:00');
    expect((await parseCmbEmailBody('招商银行月度账单已生成，欢迎查阅。', 'cmb-default', ref)).status).toBe('not_transaction');

    const multi = await parseCmbEmailBody(
      '您账户1234于11月05日10:00在商户A快捷支付1.00元，余额10.00。\n您账户1234于11月05日10:01在商户B快捷支付2.00元，余额8.00。',
      'cmb-default', ref,
    );
    expect(multi.status).toBe('ambiguous');

    const unknown = await parseCmbEmailBody('您账户1234于11月05日10:00发生了某种新格式银行业务。', 'cmb-default', ref);
    expect(unknown.status).toBe('unmatched');

    const badDate = await parseCmbEmailBody('您账户1234于02月29日10:00在商户A快捷支付1.00元，余额10.00。', 'cmb-default', new Date('2026-03-01T10:00:00+08:00'));
    expect(badDate.status).toBe('invalid_date');
  });
});
