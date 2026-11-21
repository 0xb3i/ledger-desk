/** Minimal RFC 5322 / MIME decoder for CMB bank emails (GBK/GB18030/UTF-8, base64, QP, multipart, HTML). */

export interface DecodedHeaders {
  from: string;
  subject: string;
  date: Date | null;
  messageId: string | null;
  contentType: string;
  contentTransferEncoding: string;
}

export interface DecodedEmail extends DecodedHeaders {
  text: string;
}

function normalizeCharset(charset: string | undefined): string {
  const clean = (charset ?? 'utf-8').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!clean || clean === 'utf8' || clean === 'utf-8' || clean === 'us-ascii' || clean === 'ascii') return 'utf-8';
  if (clean === 'gb2312' || clean === 'gbk' || clean === 'gb18030' || clean === 'x-gbk') return 'gb18030';
  if (clean === 'latin1' || clean === 'iso-8859-1') return 'iso-8859-1';
  return clean;
}

export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const normalized = normalizeCharset(charset);
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function decodeQuotedPrintableBytes(input: string, isHeader = false): Uint8Array {
  const normalized = isHeader ? input.replaceAll('_', ' ') : input.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '=' && i + 2 < normalized.length && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(normalized.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Decode RFC 2047 encoded words (=?charset?B|Q?text?=), collapsing whitespace between adjacent words. */
export function decodeHeaderValue(raw: string): string {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ').trim();
  const collapsed = unfolded.replace(/(\?=[ \t]+)(?==\?)/g, '?=');
  return collapsed.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, data: string) => {
    try {
      const bytes = encoding.toUpperCase() === 'B'
        ? Uint8Array.from(Buffer.from(data.replace(/\s+/g, ''), 'base64'))
        : decodeQuotedPrintableBytes(data, true);
      return decodeBytes(bytes, charset);
    } catch {
      return _match;
    }
  });
}

function splitHeaderAndBody(raw: Buffer): { headerText: string; bodyBuffer: Buffer } {
  const crlfIdx = raw.indexOf(Buffer.from('\r\n\r\n'));
  const lfIdx = raw.indexOf(Buffer.from('\n\n'));
  if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
    return { headerText: raw.subarray(0, crlfIdx).toString('latin1'), bodyBuffer: raw.subarray(crlfIdx + 4) };
  }
  if (lfIdx !== -1) {
    return { headerText: raw.subarray(0, lfIdx).toString('latin1'), bodyBuffer: raw.subarray(lfIdx + 2) };
  }
  return { headerText: raw.toString('latin1'), bodyBuffer: Buffer.alloc(0) };
}

function parseHeaderMap(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = headerText.split(/\r?\n/);
  let currentKey = '';
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentKey) {
      headers.set(currentKey, `${headers.get(currentKey) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    currentKey = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!headers.has(currentKey)) headers.set(currentKey, value);
  }
  return headers;
}

function extractParam(headerValue: string, paramName: string): string | undefined {
  const regex = new RegExp(`(?:^|;)\\s*${paramName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i');
  const match = regex.exec(headerValue);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function parseEmailHeaders(rawHeaderBuffer: Buffer | string): DecodedHeaders {
  const text = typeof rawHeaderBuffer === 'string' ? rawHeaderBuffer : rawHeaderBuffer.toString('latin1');
  const map = parseHeaderMap(text);
  const rawDate = map.get('date');
  const parsedDate = rawDate ? new Date(rawDate) : null;
  const rawMsgId = map.get('message-id')?.trim();
  return {
    from: decodeHeaderValue(map.get('from') ?? ''),
    subject: decodeHeaderValue(map.get('subject') ?? ''),
    date: parsedDate && Number.isFinite(parsedDate.valueOf()) ? parsedDate : null,
    messageId: rawMsgId || null,
    contentType: map.get('content-type') ?? 'text/plain; charset=utf-8',
    contentTransferEncoding: (map.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase(),
  };
}

function decodeBodyBytes(bodyBuffer: Buffer, transferEncoding: string): Uint8Array {
  if (transferEncoding === 'base64') {
    const cleaned = bodyBuffer.toString('latin1').replace(/\s+/g, '');
    return Uint8Array.from(Buffer.from(cleaned, 'base64'));
  }
  if (transferEncoding === 'quoted-printable') {
    return decodeQuotedPrintableBytes(bodyBuffer.toString('latin1'), false);
  }
  return new Uint8Array(bodyBuffer.buffer, bodyBuffer.byteOffset, bodyBuffer.byteLength);
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", mdash: '—', ndash: '–',
};

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (full, entity: string) => {
      if (entity.startsWith('#')) {
        const hex = entity[1].toLowerCase() === 'x';
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
      }
      return HTML_ENTITIES[entity.toLowerCase()] ?? full;
    })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ExtractedBodies {
  plain: string[];
  html: string[];
}

function collectParts(raw: Buffer, depth: number, out: ExtractedBodies): void {
  if (depth > 8) return;
  const { headerText, bodyBuffer } = splitHeaderAndBody(raw);
  const headers = parseEmailHeaders(headerText);
  const mimeType = headers.contentType.split(';', 1)[0].trim().toLowerCase();

  if (mimeType.startsWith('multipart/')) {
    const boundary = extractParam(headers.contentType, 'boundary');
    if (!boundary) return;
    const bodyStr = bodyBuffer.toString('latin1');
    const delimiter = `--${boundary}`;
    const segments = bodyStr.split(delimiter);
    for (let i = 1; i < segments.length; i++) {
      let segment = segments[i];
      if (segment.startsWith('--')) break;
      segment = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      if (!segment) continue;
      collectParts(Buffer.from(segment, 'latin1'), depth + 1, out);
    }
    return;
  }

  if (mimeType === 'text/plain' || mimeType === 'text/html') {
    const charset = extractParam(headers.contentType, 'charset');
    const decoded = decodeBytes(decodeBodyBytes(bodyBuffer, headers.contentTransferEncoding), charset);
    if (mimeType === 'text/plain') out.plain.push(decoded);
    else out.html.push(decoded);
  }
}

export function decodeRawEmail(raw: Buffer): DecodedEmail {
  const { headerText } = splitHeaderAndBody(raw);
  const headers = parseEmailHeaders(headerText);
  const extracted: ExtractedBodies = { plain: [], html: [] };
  collectParts(raw, 0, extracted);
  const plainJoined = extracted.plain.map(s => s.trim()).filter(Boolean).join('\n').trim();
  const htmlJoined = extracted.html.map(htmlToPlainText).filter(Boolean).join('\n').trim();
  // Prefer text/plain when it contains useful content, otherwise fall back to text/html.
  const text = plainJoined.length >= 10 ? plainJoined : (htmlJoined || plainJoined);
  return { ...headers, text };
}
