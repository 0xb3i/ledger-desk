import { describe, expect, it } from 'vitest';
import { decodeHeaderValue, decodeRawEmail, htmlToPlainText } from '../src/local/mime';

describe('本地 MIME 邮件解码', () => {
  it('解码 RFC 2047 UTF-8 与 GB18030 邮件头', () => {
    const utf8Subject = `=?UTF-8?B?${Buffer.from('招商银行一卡通动账通知', 'utf8').toString('base64')}?=`;
    expect(decodeHeaderValue(utf8Subject)).toBe('招商银行一卡通动账通知');
    // GB18030 bytes for "招商银行"
    const gbFrom = `=?GB18030?B?${Buffer.from([0xd5, 0xd0, 0xc9, 0xcc, 0xd2, 0xf8, 0xd0, 0xd0]).toString('base64')}?= <95555@cmbchina.com>`;
    expect(decodeHeaderValue(gbFrom)).toBe('招商银行 <95555@cmbchina.com>');
  });

  it('解码 multipart/alternative 邮件并优先提取纯文本正文', () => {
    const plainBase64 = Buffer.from('您账户1234于11月02日09:15在美团快捷支付28.50元，余额100.00。', 'utf8').toString('base64');
    const htmlBase64 = Buffer.from('<div><p>HTML 版本</p></div>', 'utf8').toString('base64');
    const raw = Buffer.from([
      'From: =?UTF-8?B?5oub5ZWG6ZO26KGM?= <95555@cmbchina.com>',
      'Subject: =?UTF-8?B?6LSm5oi35Y+Y5Yqo6YCa55+l?=',
      'Date: Mon, 02 Nov 2026 09:15:30 +0800',
      'Message-ID: <cmb-msg-1@cmbchina.com>',
      'Content-Type: multipart/alternative; boundary="bnd_test_1"',
      '',
      '--bnd_test_1',
      'Content-Type: text/plain; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      plainBase64,
      '--bnd_test_1',
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      htmlBase64,
      '--bnd_test_1--',
      '',
    ].join('\r\n'), 'latin1');

    const decoded = decodeRawEmail(raw);
    expect(decoded.from).toBe('招商银行 <95555@cmbchina.com>');
    expect(decoded.subject).toBe('账户变动通知');
    expect(decoded.messageId).toBe('<cmb-msg-1@cmbchina.com>');
    expect(decoded.date?.toISOString()).toBe('2026-11-02T01:15:30.000Z');
    expect(decoded.text).toContain('快捷支付28.50元');
  });

  it('支持纯 HTML 邮件与实体清理', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><p>尊敬的客户：</p><div>您账户1234于11月02日09:15在&nbsp;美团&amp;点评快捷支付28.50元，余额100.00。</div></body></html>';
    const raw = Buffer.from([
      'From: 95555@cmbchina.com',
      'Subject: CMB Alert',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
    ].join('\r\n'), 'latin1');

    const decoded = decodeRawEmail(raw);
    expect(decoded.text).toContain('美团&点评快捷支付28.50元');
    expect(htmlToPlainText('<script>alert(1)</script><p>A<br/>B</p>')).toBe('A\nB');
  });
});
