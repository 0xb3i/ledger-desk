import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isLikelyCmbEmailHeader } from '../src/server/ledger/cmb-email-parser';
import { formatImapDate, pullImapMessages, testImapConnection } from '../src/local/imap';

interface MockMail {
  uid: number;
  internalDate: string;
  rawHeader: string;
  rawBody: string;
  size?: number;
}

function createMockImapServer(options: {
  uidValidity: number;
  uidNext?: number;
  expectedUser: string;
  expectedPass: string;
  mails: MockMail[];
  commands?: string[];
}) {
  return () => {
    const clientSide = new PassThrough();
    const serverSide = new PassThrough();
    const duplex = new PassThrough();
    // Wire duplex <-> mock server handler using two PassThrough pipes
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const socket = Object.assign(new PassThrough(), {
      _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        incoming.write(chunk, encoding, callback);
      },
    });
    outgoing.on('data', chunk => socket.push(chunk));
    outgoing.on('end', () => socket.push(null));

    // Send greeting asynchronously
    queueMicrotask(() => {
      outgoing.write('* OK QQMail IMAP4rev1 mock ready\r\n');
    });

    let buf = '';
    incoming.setEncoding('latin1');
    incoming.on('data', chunk => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const space = line.indexOf(' ');
        const tag = line.slice(0, space);
        const cmd = line.slice(space + 1);
        options.commands?.push(cmd);

        if (cmd.startsWith('LOGIN ')) {
          if (cmd === `LOGIN "${options.expectedUser}" "${options.expectedPass}"`) {
            outgoing.write(`${tag} OK LOGIN completed\r\n`);
          } else {
            outgoing.write(`${tag} NO Authentication failed\r\n`);
          }
        } else if (cmd.startsWith('EXAMINE ')) {
          outgoing.write(`* OK [UIDVALIDITY ${options.uidValidity}] UIDs valid\r\n`);
          if (options.uidNext) outgoing.write(`* OK [UIDNEXT ${options.uidNext}] Predicted next UID\r\n`);
          outgoing.write(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        } else if (cmd.startsWith('UID SEARCH ')) {
          // Simulate RFC 3501 quirk where UID N:* still includes highest UID even if <= N-1.
          const uids = options.mails.map(m => m.uid);
          outgoing.write(`* SEARCH ${uids.join(' ')}\r\n`);
          outgoing.write(`${tag} OK UID SEARCH completed\r\n`);
        } else if (cmd.startsWith('UID FETCH ') && cmd.includes('HEADER.FIELDS')) {
          const uidList = cmd.split(' ')[2].split(',').map(Number);
          for (const mail of options.mails.filter(m => uidList.includes(m.uid))) {
            const bytes = Buffer.from(mail.rawHeader, 'latin1');
            outgoing.write(`* ${mail.uid} FETCH (UID ${mail.uid} INTERNALDATE "${mail.internalDate}" RFC822.SIZE ${mail.size ?? Buffer.byteLength(mail.rawBody)} BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${bytes.length}}\r\n`);
            outgoing.write(bytes);
            outgoing.write(')\r\n');
          }
          outgoing.write(`${tag} OK UID FETCH completed\r\n`);
        } else if (cmd.startsWith('UID FETCH ') && cmd.includes('BODY.PEEK[]')) {
          const uidList = cmd.split(' ')[2].split(',').map(Number);
          for (const mail of options.mails.filter(m => uidList.includes(m.uid))) {
            const bytes = Buffer.from(mail.rawBody, 'utf8');
            outgoing.write(`* ${mail.uid} FETCH (UID ${mail.uid} INTERNALDATE "${mail.internalDate}" BODY[] {${bytes.length}}\r\n`);
            outgoing.write(bytes);
            outgoing.write(')\r\n');
          }
          outgoing.write(`${tag} OK UID FETCH completed\r\n`);
        } else if (cmd === 'LOGOUT') {
          outgoing.write('* BYE Logout\r\n');
          outgoing.write(`${tag} OK LOGOUT completed\r\n`);
          outgoing.end();
        } else {
          outgoing.write(`${tag} BAD Unknown command\r\n`);
        }
      }
    });

    void clientSide; void serverSide; void duplex;
    return socket;
  };
}

describe('只读 IMAP 客户端', () => {
  it('按 RFC 3501 格式化查询日期', () => {
    expect(formatImapDate('2026-11-20')).toBe('20-Nov-2026');
    expect(() => formatImapDate('2026-13-01')).toThrow();
  });

  it('只使用 EXAMINE 与 BODY.PEEK 读取招行邮件，并过滤非招行邮件与旧 UID', async () => {
    const commands: string[] = [];
    const cmbRaw = [
      'From: =?UTF-8?B?5oub5ZWG6ZO26KGM?= <95555@cmbchina.com>',
      'Subject: =?UTF-8?B?6LSm5oi35Y+Y5Yqo6YCa55+l?=',
      'Date: Fri, 20 Nov 2026 10:00:00 +0800',
      'Message-ID: <cmb-102@cmbchina.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '您账户1234于11月20日10:00在美团快捷支付18.00元，余额500.00。',
    ].join('\r\n');
    const otherRaw = [
      'From: news@example.com',
      'Subject: Weekly Digest',
      'Date: Fri, 20 Nov 2026 09:00:00 +0800',
      'Message-ID: <other-101@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hello world',
    ].join('\r\n');

    const mails: MockMail[] = [
      { uid: 100, internalDate: '19-Nov-2026 10:00:00 +0800', rawHeader: cmbRaw.split('\r\n\r\n')[0], rawBody: cmbRaw },
      { uid: 101, internalDate: '20-Nov-2026 09:00:00 +0800', rawHeader: otherRaw.split('\r\n\r\n')[0], rawBody: otherRaw },
      { uid: 102, internalDate: '20-Nov-2026 10:00:00 +0800', rawHeader: cmbRaw.split('\r\n\r\n')[0], rawBody: cmbRaw },
    ];

    const connectSocket = createMockImapServer({
      uidValidity: 42,
      uidNext: 103,
      expectedUser: '123456@qq.com',
      expectedPass: 'abcdefghijklmnop',
      mails,
      commands,
    });

    const result = await pullImapMessages({
      host: 'imap.qq.com',
      port: 993,
      email: '123456@qq.com',
      authCode: 'abcdefghijklmnop',
      mailbox: 'INBOX',
      connectSocket,
    }, {
      expectedUidValidity: 42,
      fromUid: 100,
      fromContains: 'cmbchina',
      headerFilter: h => isLikelyCmbEmailHeader(h.headers.from, h.headers.subject),
    });

    expect(result.mailbox).toEqual({ uidValidity: 42, uidNext: 103 });
    expect(result.scannedMaxUid).toBe(102);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].uid).toBe(102);
    expect(result.messages[0].email.text).toContain('快捷支付18.00元');
    expect(commands.some(c => c.startsWith('EXAMINE "INBOX"'))).toBe(true);
    expect(commands.some(c => c.startsWith('SELECT '))).toBe(false);
    expect(commands.some(c => c.startsWith('UID SEARCH ') && c.includes('FROM "cmbchina"'))).toBe(true);
    expect(commands.some(c => c.includes('BODY.PEEK[]') && c.includes('102') && !c.includes('101'))).toBe(true);
  });

  it('超过正文大小限制的邮件进入待核对，后续邮件照常解码', async () => {
    const commands: string[] = [];
    const rawHeader = 'From: 95555@cmbchina.com\r\nContent-Type: text/html; charset=utf-8';
    const internalDate = '20-Nov-2026 10:00:00 +0800';
    const connectSocket = createMockImapServer({ uidValidity: 42, expectedUser: 'test@qq.com', expectedPass: 'test-password', commands,
      mails: [
        { uid: 1, internalDate, rawHeader, rawBody: '', size: 26 * 1024 * 1024 },
        { uid: 2, internalDate, rawHeader, rawBody: rawHeader + '\r\n\r\n<p>&#xFFFFFF;账单&#1114112; &#x1f600;</p>' },
      ],
    });
    const result = await pullImapMessages({ host: 'imap.qq.com', port: 993, mailbox: 'INBOX',
      email: 'test@qq.com', authCode: 'test-password', connectSocket }, {});
    expect(result.scannedMaxUid).toBe(2);
    expect(result.messages.map(message => [message.uid, message.email.text, Boolean(message.decodeError)])).toEqual([
      [1, '', true], [2, '�账单� 😀', false],
    ]);
    expect(commands.filter(command => command.includes('BODY.PEEK[]'))).toEqual(['UID FETCH 2 (UID INTERNALDATE BODY.PEEK[])']);
  });

  it('授权码错误时返回明确中文提示', async () => {
    const connectSocket = createMockImapServer({
      uidValidity: 42,
      expectedUser: '123456@qq.com',
      expectedPass: 'correctcode12345',
      mails: [],
    });
    await expect(testImapConnection({
      host: 'imap.qq.com',
      port: 993,
      email: '123456@qq.com',
      authCode: 'wrongcode1234567',
      mailbox: 'INBOX',
      connectSocket,
    })).rejects.toThrow('QQ 邮箱登录失败');
  });
});
