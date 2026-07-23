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

// mailparser returns a single AddressObject normally, but an array of them
// when a header (e.g. "To") repeats — real in a 20+ year POP3 archive.
function addressText(addressField) {
  if (!addressField) return null;
  if (Array.isArray(addressField)) {
    return addressField.map((a) => a.text).join(', ') || null;
  }
  return addressField.text || null;
}

// Parses one raw mbox message (as produced by splitMboxMessages) into a
// plain object matching the `messages` table shape, plus an `attachments`
// array of { filename, contentType, size, content } for the caller to
// hash/write to disk and insert separately.
async function parseMboxMessage({ mboxFile, offset, raw }) {
  const rfc822 = unwrapEnvelope(raw);
  const parsed = await simpleParser(rfc822, { skipHtmlToText: true });

  const messageId = parsed.messageId || `<${mboxFile}:${offset}@local-synthetic>`;
  const dateUtc = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf())
    ? parsed.date
    : null;

  return {
    message: {
      messageId,
      mboxFile,
      byteOffset: offset,
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
    attachments: parsed.attachments.map((att) => ({
      filename: att.filename || null,
      contentType: att.contentType || null,
      size: att.size || att.content.length,
      content: att.content,
    })),
  };
}

module.exports = { splitMboxMessages, unwrapEnvelope, parseMboxMessage };
