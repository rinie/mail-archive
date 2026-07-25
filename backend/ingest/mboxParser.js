const crypto = require('node:crypto');
const { simpleParser } = require('mailparser');

const ESCAPED_FROM_LINE_RE = /^(>+)From /;

// Byte-accurate split of an mbox buffer into raw per-message slices (each
// still carries its leading "From " envelope line). `baseOffset` is the
// file-absolute offset of buffer[0], so results stay absolute when this
// runs against a tail slice during incremental ingestion. Message text is
// treated as latin1 (a 1:1 byte<->char mapping) purely so boundary search
// and the mboxrd ">From " unescape below can address exact byte positions
// without disturbing multi-byte UTF-8 (or other charset) content elsewhere
// in the message.
function splitMboxMessages(buffer, baseOffset = 0) {
  const boundaries = [];

  if (buffer.length >= 5 && buffer.toString('latin1', 0, 5) === 'From ') {
    boundaries.push(0);
  }
  let idx = buffer.indexOf('\nFrom ', 0, 'latin1');
  while (idx !== -1) {
    boundaries.push(idx + 1);
    idx = buffer.indexOf('\nFrom ', idx + 1, 'latin1');
  }

  return boundaries.map((start, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : buffer.length;
    return { offset: baseOffset + start, raw: buffer.subarray(start, end) };
  });
}

// Strips the mbox "From " envelope line and reverses mboxrd-style body
// escaping (a line matching /^>+From / had one '>' prepended on write; we
// remove exactly one on read). Byte-preserving except for that one '>'.
function unwrapEnvelope(rawMessage) {
  const text = rawMessage.toString('latin1');
  const firstNewline = text.indexOf('\n');
  const rest = firstNewline === -1 ? '' : text.slice(firstNewline + 1);

  const unescaped = rest
    .split('\n')
    .map((line) => (ESCAPED_FROM_LINE_RE.test(line) ? line.slice(1) : line))
    .join('\n');

  return Buffer.from(unescaped, 'latin1');
}

// A handful of US zone *names* (rather than an RFC 2822 numeric offset)
// turn up from old Outlook/Outlook Express senders. Each already resolves
// DST unambiguously (the name itself says "Daylight" or "Standard"), so
// mapping to a fixed offset is safe, unlike an abbreviation such as "WET"
// which is genuinely ambiguous across a DST transition.
const NAMED_ZONE_OFFSETS = {
  'pacific daylight time': '-0700',
  'pacific standard time': '-0800',
  'mountain daylight time': '-0600',
  'mountain standard time': '-0700',
  'central daylight time': '-0500',
  'central standard time': '-0600',
  'eastern daylight time': '-0400',
  'eastern standard time': '-0500',
};

// Best-effort recovery for a Date header mailparser/JS Date couldn't
// parse. Only handles patterns independently verified against real mail
// in this archive; anything else is left null rather than guessed.
function repairDateHeader(rawDateText) {
  if (!rawDateText) return null;

  // A stray single-letter token wedged between the seconds and a numeric
  // UTC offset — seen identically across multiple unrelated senders/
  // gateways in this archive, e.g. "16:30:07 C -0500" -> "16:30:07 -0500".
  let candidate = rawDateText.replace(/(\d{2}:\d{2}:\d{2})\s+[A-Z]\s+([+-]\d{4})/, '$1 $2');

  const lower = candidate.toLowerCase();
  const namedZone = Object.keys(NAMED_ZONE_OFFSETS).find((name) => lower.endsWith(name));
  if (namedZone) {
    const prefix = candidate.slice(0, candidate.length - namedZone.length);
    candidate = prefix + NAMED_ZONE_OFFSETS[namedZone];
  }

  const repaired = new Date(candidate);
  return Number.isNaN(repaired.valueOf()) ? null : repaired;
}

// mailparser returns a single AddressObject normally, but an array of them
// when a header (e.g. "To") repeats — real in a 20+ year POP3 archive.
function addressText(addressField) {
  if (!addressField) return null;
  if (Array.isArray(addressField)) {
    return addressField.map((a) => a.text).join(', ') || null;
  }
  return addressField.text || null;
}

function getRawDateHeaderValue(parsed) {
  const headerLine = parsed.headerLines.find((h) => h.key === 'date');
  if (!headerLine) return null;
  const colonIdx = headerLine.line.indexOf(':');
  return colonIdx === -1 ? null : headerLine.line.slice(colonIdx + 1).trim();
}

// Parses one raw mbox message (as produced by splitMboxMessages) into a
// plain object matching the `messages` table shape, plus an `attachments`
// array of { filename, contentType, size, content } for the caller to
// hash/write to disk and insert separately.
async function parseMboxMessage({ mboxFile, offset, raw }) {
  const rfc822 = unwrapEnvelope(raw);
  const parseStartedAt = Date.now();
  const parsed = await simpleParser(rfc822, { skipHtmlToText: true });

  // A position-based synthetic id (mboxFile+offset) is unstable across any
  // relocation (partitioning, or even a plain Thunderbird compaction) --
  // confirmed by a real partition-run failure where these 4 messages'
  // "identity" changed the moment they moved, breaking the primary-key
  // invariant. Content is stable across moves; position is not.
  const messageId = parsed.messageId
    || `<${crypto.createHash('sha256').update(raw).digest('hex')}@local-synthetic>`;

  // mailparser silently falls back to `new Date()` for a Date header it
  // can't parse (confirmed against real mail in this archive with a
  // malformed header — "Tue, 10 Jul 2001 16:30:07 C -0500", a stray token
  // from a broken sender mailer) instead of leaving the date unset. A
  // 22-year-old message's Date header can never legitimately land within
  // seconds of "whenever this ingest run happened to parse it," so that
  // signature reliably identifies the fallback.
  const isValidDate = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf());
  const looksLikeFallbackToNow = isValidDate
    && Math.abs(parsed.date.getTime() - parseStartedAt) < 5000;
  const dateUtc = isValidDate && !looksLikeFallbackToNow
    ? parsed.date
    : repairDateHeader(getRawDateHeaderValue(parsed));

  return {
    message: {
      messageId,
      mboxFile,
      byteOffset: offset,
      byteLength: raw.length,
      dateUtc,
      year: dateUtc ? dateUtc.getUTCFullYear() : null,
      month: dateUtc ? dateUtc.getUTCMonth() + 1 : null,
      fromAddr: addressText(parsed.from),
      toAddr: addressText(parsed.to),
      subject: parsed.subject || null,
      bodyText: parsed.text || null,
      bodyHtml: parsed.html || null,
      hasAttachments: parsed.attachments.length > 0,
    },
    // attachmentIndex is the 0-based ordinal into this array, stored
    // alongside each attachment's metadata so on-demand retrieval can pick
    // "the Nth attachment" unambiguously — two attachments on one message
    // can share a filename.
    attachments: parsed.attachments.map((att, attachmentIndex) => ({
      attachmentIndex,
      filename: att.filename || null,
      contentType: att.contentType || null,
      size: att.size || att.content.length,
      content: att.content,
    })),
  };
}

module.exports = { splitMboxMessages, unwrapEnvelope, parseMboxMessage };
