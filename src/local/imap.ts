import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { decodeRawEmail, parseEmailHeaders, type DecodedEmail, type DecodedHeaders } from './mime';

export interface ImapConnectionOptions {
  host: string;
  port: number;
  email: string;
  authCode: string;
  mailbox: string;
  timeoutMs?: number;
  /** Optional custom socket factory for isolated unit tests. */
  connectSocket?: () => Duplex;
}

export interface MailboxStatus {
  uidValidity: number;
  uidNext: number | null;
}

export interface FetchedHeader {
  uid: number;
  internalDate: Date | null;
  headers: DecodedHeaders;
}

export interface FetchedMessage {
  uid: number;
  internalDate: Date | null;
  email: DecodedEmail;
  decodeError?: string;
}

function unreadableMessage(header: FetchedHeader, decodeError: string): FetchedMessage {
  return { uid: header.uid, internalDate: header.internalDate, email: { ...header.headers, text: '' }, decodeError };
}

interface ImapFrame {
  segments: string[];
  literals: Buffer[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MAX_MAIL_BYTES = 25 * 1024 * 1024;
const CRLF = Buffer.from('\r\n');

export function formatImapDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`无效日期格式：${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`无效日期：${isoDate}`);
  return `${String(day).padStart(2, '0')}-${MONTHS[month - 1]}-${year}`;
}

export function addDaysIsoDate(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`无效日期格式：${isoDate}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

function quoteImapString(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('IMAP 参数包含非法换行或空字符。');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

class ImapFrameParser {
  private buffer = Buffer.alloc(0);
  private currentSegments: string[] = [];
  private currentLiterals: Buffer[] = [];
  private expectedLiteralBytes: number | null = null;
  private frames: ImapFrame[] = [];

  push(chunk: Buffer): ImapFrame[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const emitted: ImapFrame[] = [];
    while (true) {
      if (this.expectedLiteralBytes !== null) {
        if (this.buffer.length < this.expectedLiteralBytes) break;
        const literal = Buffer.from(this.buffer.subarray(0, this.expectedLiteralBytes));
        this.buffer = this.buffer.subarray(this.expectedLiteralBytes);
        this.currentLiterals.push(literal);
        this.expectedLiteralBytes = null;
        continue;
      }
      const lineEnd = this.buffer.indexOf(CRLF);
      if (lineEnd === -1) break;
      const line = this.buffer.subarray(0, lineEnd).toString('latin1');
      this.buffer = this.buffer.subarray(lineEnd + 2);
      const literalMatch = /\{(\d+)\}$/.exec(line);
      this.currentSegments.push(line);
      if (literalMatch) {
        this.expectedLiteralBytes = Number.parseInt(literalMatch[1], 10);
        if (!Number.isSafeInteger(this.expectedLiteralBytes) || this.expectedLiteralBytes > MAX_MAIL_BYTES) {
          throw new Error('邮件体积超出本地解析限制。');
        }
        continue;
      }
      emitted.push({ segments: this.currentSegments, literals: this.currentLiterals });
      this.currentSegments = [];
      this.currentLiterals = [];
    }
    this.frames.push(...emitted);
    return emitted;
  }

  shift(): ImapFrame | undefined {
    return this.frames.shift();
  }
}

class ReadOnlyImapSession {
  private readonly socket: Duplex;
  private readonly parser = new ImapFrameParser();
  private readonly timeoutMs: number;
  private waiter: { resolve: (frame: ImapFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private closedError: Error | null = null;
  private tagCounter = 0;

  constructor(socket: Duplex, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.on('data', (chunk: Buffer | string) => {
      try {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
        this.parser.push(buf);
        this.drainWaiter();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('邮箱协议解析失败。'));
      }
    });
    socket.on('error', () => {
      this.fail(new Error('无法连接 QQ 邮箱服务器，请检查网络连接。'));
    });
    socket.on('close', () => {
      this.fail(new Error('与 QQ 邮箱的连接意外中断，请稍后重试。'));
    });
  }

  private drainWaiter(): void {
    if (!this.waiter) return;
    const frame = this.parser.shift();
    if (!frame) return;
    const { resolve, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    resolve(frame);
  }

  private fail(error: Error): void {
    if (!this.closedError) this.closedError = error;
    if (this.waiter) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(this.closedError);
    }
  }

  private nextFrame(): Promise<ImapFrame> {
    const queued = this.parser.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<ImapFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.socket.destroy();
        reject(new Error('连接 QQ 邮箱超时，请检查网络后重试。'));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  async readGreeting(): Promise<void> {
    const frame = await this.nextFrame();
    const first = frame.segments[0] ?? '';
    if (!first.startsWith('* OK')) {
      throw new Error('QQ 邮箱服务器返回了意外的握手状态。');
    }
  }

  async command(cmd: string): Promise<{ status: 'OK' | 'NO' | 'BAD'; text: string; untagged: ImapFrame[] }> {
    const tag = `A${String(++this.tagCounter).padStart(4, '0')}`;
    this.socket.write(`${tag} ${cmd}\r\n`, 'latin1');
    const untagged: ImapFrame[] = [];
    while (true) {
      const frame = await this.nextFrame();
      const head = frame.segments[0] ?? '';
      if (head.startsWith(`${tag} `)) {
        const match = new RegExp(`^${tag} (OK|NO|BAD)(?:\\s+(.*))?$`, 'i').exec(head);
        if (!match) throw new Error('邮箱服务器响应格式异常。');
        return {
          status: match[1].toUpperCase() as 'OK' | 'NO' | 'BAD',
          text: match[2] ?? '',
          untagged,
        };
      }
      untagged.push(frame);
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.closedError && !this.socket.destroyed) {
        this.socket.write(`A${String(++this.tagCounter).padStart(4, '0')} LOGOUT\r\n`, 'latin1');
      }
    } catch {
      // ignore teardown errors
    } finally {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

function parseFetchMeta(frame: ImapFrame): { uid: number; internalDate: Date | null; size: number | null } | null {
  const head = frame.segments[0] ?? '';
  if (!/^\*\s+\d+\s+FETCH\s+\(/i.test(head)) return null;
  const joined = frame.segments.join(' ');
  const uidMatch = /\bUID\s+(\d+)/i.exec(joined);
  if (!uidMatch) return null;
  const dateMatch = /\bINTERNALDATE\s+"([^"]+)"/i.exec(joined);
  const parsedDate = dateMatch ? new Date(dateMatch[1]) : null;
  return {
    uid: Number.parseInt(uidMatch[1], 10),
    size: Number(/\bRFC822\.SIZE\s+(\d+)/i.exec(joined)?.[1] ?? NaN) || null,
    internalDate: parsedDate && Number.isFinite(parsedDate.valueOf()) ? parsedDate : null,
  };
}

async function openSession(options: ImapConnectionOptions): Promise<{ session: ReadOnlyImapSession; mailbox: MailboxStatus }> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  let socket: Duplex;
  if (options.connectSocket) {
    socket = options.connectSocket();
  } else {
    socket = await new Promise<TLSSocket>((resolve, reject) => {
      let settled = false;
      const tlsSocket = tlsConnect({
        host: options.host,
        port: options.port,
        servername: options.host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(tlsSocket);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        tlsSocket.destroy();
        reject(new Error(`连接 ${options.host}:${options.port} 超时，请检查网络连接。`));
      }, timeoutMs);
      tlsSocket.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`无法连接 ${options.host}:${options.port}，请检查网络或 TLS 证书。`));
      });
    });
  }

  const session = new ReadOnlyImapSession(socket, timeoutMs);
  try {
    await session.readGreeting();
    const login = await session.command(`LOGIN ${quoteImapString(options.email)} ${quoteImapString(options.authCode)}`);
    if (login.status !== 'OK') {
      throw new Error('QQ 邮箱登录失败，请确认已开启 IMAP 服务并填写正确的 16 位授权码。');
    }
    // EXAMINE opens the mailbox strictly read-only without changing \Seen flags.
    const examine = await session.command(`EXAMINE ${quoteImapString(options.mailbox)}`);
    if (examine.status !== 'OK') {
      throw new Error(`无法只读打开邮箱目录 ${options.mailbox}。`);
    }
    let uidValidity = 0;
    let uidNext: number | null = null;
    for (const frame of examine.untagged) {
      const line = frame.segments[0] ?? '';
      const validMatch = /\[UIDVALIDITY\s+(\d+)\]/i.exec(line);
      if (validMatch) uidValidity = Number.parseInt(validMatch[1], 10);
      const nextMatch = /\[UIDNEXT\s+(\d+)\]/i.exec(line);
      if (nextMatch) uidNext = Number.parseInt(nextMatch[1], 10);
    }
    if (!uidValidity) {
      throw new Error('邮箱服务器未返回 UIDVALIDITY，暂时无法建立增量游标。');
    }
    return { session, mailbox: { uidValidity, uidNext } };
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function testImapConnection(options: ImapConnectionOptions): Promise<MailboxStatus> {
  const { session, mailbox } = await openSession(options);
  await session.close();
  return mailbox;
}

export async function fetchSingleImapMessage(
  options: ImapConnectionOptions,
  expectedUidValidity: number,
  uid: number,
): Promise<FetchedMessage | null> {
  const { session, mailbox } = await openSession(options);
  try {
    if (mailbox.uidValidity !== expectedUidValidity) return null;
    const fetched = await session.command(`UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[])`);
    if (fetched.status !== 'OK') throw new Error('读取邮件原文失败，请稍后重试。');
    for (const frame of fetched.untagged) {
      const meta = parseFetchMeta(frame);
      if (!meta || meta.uid !== uid) continue;
      const rawBody = frame.literals[0];
      if (!rawBody) continue;
      return {
        uid: meta.uid,
        internalDate: meta.internalDate,
        email: decodeRawEmail(rawBody),
      };
    }
    return null;
  } finally {
    await session.close();
  }
}

export interface ImapPullQuery {
  expectedUidValidity?: number;
  fromUid?: number;
  sinceDate?: string;
  beforeDate?: string;
  fallbackSinceDate?: string;
  /** Pure ASCII server-side IMAP FROM filter (e.g. "cmbchina") for fast large-range scans. */
  fromContains?: string;
  headerFilter?: (header: FetchedHeader) => boolean;
  /** Called as soon as target message count is known and after each downloaded batch. */
  onProgress?: (info: { total: number; processed: number }) => void;
  /** Called per downloaded batch (up to 15 messages) so callers can stream directly to SQLite. */
  onBatch?: (batch: FetchedMessage[], mailbox: MailboxStatus) => Promise<void>;
}

export interface ImapPullResult {
  mailbox: MailboxStatus;
  scannedMaxUid: number | null;
  messages: FetchedMessage[];
}

function parseSearchUids(untagged: ImapFrame[], effectiveFromUid?: number): number[] {
  const uids: number[] = [];
  for (const frame of untagged) {
    const line = frame.segments[0] ?? '';
    const match = /^\*\s+SEARCH(?:\s+(.*))?$/i.exec(line);
    if (!match || !match[1]) continue;
    for (const token of match[1].trim().split(/\s+/)) {
      const value = Number.parseInt(token, 10);
      if (Number.isInteger(value) && value > 0) {
        // RFC 3501: `UID N:*` always includes the highest existing UID even if < N.
        if (effectiveFromUid === undefined || value > effectiveFromUid) uids.push(value);
      }
    }
  }
  return [...new Set(uids)].sort((a, b) => a - b);
}

async function searchUids(session: ReadOnlyImapSession, query: ImapPullQuery, uidValidityChanged: boolean): Promise<number[]> {
  const effectiveFromUid = uidValidityChanged ? undefined : query.fromUid;
  const effectiveSinceDate = uidValidityChanged ? (query.fallbackSinceDate ?? query.sinceDate) : query.sinceDate;
  const baseCriteria: string[] = [];
  if (effectiveFromUid !== undefined && effectiveFromUid > 0) {
    baseCriteria.push(`UID ${effectiveFromUid + 1}:*`);
  }
  if (effectiveSinceDate) {
    baseCriteria.push(`SINCE ${formatImapDate(effectiveSinceDate)}`);
  }
  if (query.beforeDate) {
    baseCriteria.push(`BEFORE ${formatImapDate(query.beforeDate)}`);
  }

  if (query.fromContains) {
    const filteredCriteria = [...baseCriteria, `FROM ${quoteImapString(query.fromContains)}`];
    const filtered = await session.command(`UID SEARCH ${filteredCriteria.join(' ')}`);
    if (filtered.status === 'OK') {
      return parseSearchUids(filtered.untagged, effectiveFromUid);
    }
    // Fall back to unfiltered search if server rejects FROM search criterion.
  }

  const searchCmd = baseCriteria.length ? `UID SEARCH ${baseCriteria.join(' ')}` : 'UID SEARCH ALL';
  const result = await session.command(searchCmd);
  if (result.status !== 'OK') {
    throw new Error('搜索 QQ 邮箱邮件列表失败，请稍后重试。');
  }
  return parseSearchUids(result.untagged, effectiveFromUid);
}

export async function pullImapMessages(options: ImapConnectionOptions, query: ImapPullQuery): Promise<ImapPullResult> {
  const { session, mailbox } = await openSession(options);
  try {
    const uidValidityChanged = query.expectedUidValidity !== undefined && query.expectedUidValidity !== mailbox.uidValidity;
    const uids = await searchUids(session, query, uidValidityChanged);
    if (!uids.length) {
      return { mailbox, scannedMaxUid: null, messages: [] };
    }
    const scannedMaxUid = uids[uids.length - 1];
    const headers = new Map<number, FetchedHeader>();
    const oversized = new Set<number>();
    for (let i = 0; i < uids.length; i += 50) {
      const batch = uids.slice(i, i + 50);
      const fetched = await session.command(
        `UID FETCH ${batch.join(',')} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`,
      );
      if (fetched.status !== 'OK') throw new Error('读取邮件头信息失败，请稍后重试。');
      for (const frame of fetched.untagged) {
        const meta = parseFetchMeta(frame);
        if (!meta || !batch.includes(meta.uid)) continue;
        const header: FetchedHeader = {
          uid: meta.uid,
          internalDate: meta.internalDate,
          headers: parseEmailHeaders(frame.literals[0] ?? Buffer.alloc(0)),
        };
        if (query.headerFilter && !query.headerFilter(header)) continue;
        headers.set(meta.uid, header);
        if (meta.size !== null && meta.size > MAX_MAIL_BYTES) oversized.add(meta.uid);
      }
    }
    const targetUids = uids.filter(uid => headers.has(uid));
    query.onProgress?.({ total: targetUids.length, processed: 0 });
    const messages: FetchedMessage[] = [];
    let processed = 0;
    for (let i = 0; i < targetUids.length; i += 15) {
      const batchUids = targetUids.slice(i, i + 15);
      const downloadUids = batchUids.filter(uid => !oversized.has(uid));
      const batchMessages: FetchedMessage[] = batchUids.filter(uid => oversized.has(uid)).map(uid =>
        unreadableMessage(headers.get(uid)!, '邮件超过 25 MB，请在邮箱中查看原文后补录。'));
      if (downloadUids.length) {
        const fetched = await session.command(`UID FETCH ${downloadUids.join(',')} (UID INTERNALDATE BODY.PEEK[])`);
        if (fetched.status !== 'OK') throw new Error('下载招商银行邮件正文失败，请稍后重试。');
        for (const frame of fetched.untagged) {
          const meta = parseFetchMeta(frame);
          const rawBody = frame.literals[0];
          if (!meta || !rawBody || !downloadUids.includes(meta.uid)) continue;
          try {
            batchMessages.push({ uid: meta.uid, internalDate: meta.internalDate, email: decodeRawEmail(rawBody) });
          } catch {
            batchMessages.push(unreadableMessage(headers.get(meta.uid)!, '无法解析邮件正文，请在邮箱中查看原文后补录。'));
          }
        }
      }
      batchMessages.sort((a, b) => a.uid - b.uid);
      if (query.onBatch) {
        await query.onBatch(batchMessages, mailbox);
      } else {
        messages.push(...batchMessages);
      }
      processed += batchUids.length;
      query.onProgress?.({ total: targetUids.length, processed: Math.min(processed, targetUids.length) });
    }
    messages.sort((a, b) => a.uid - b.uid);
    return { mailbox, scannedMaxUid, messages };
  } finally {
    await session.close();
  }
}
