const fs = require('node:fs');
const { getLocation } = require('./locationIndex');
const { parseMboxMessage } = require('./mboxParser');

const SYNTHETIC_ID_RE = /@local-synthetic>$/;

function readExactRange(mboxFile, byteOffset, byteLength) {
  const buffer = Buffer.alloc(byteLength);
  const fd = fs.openSync(mboxFile, 'r');
  try {
    fs.readSync(fd, buffer, 0, byteLength, byteOffset);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

// Given a message's current mboxFile (as known by mail.duckdb's
// messages.mbox_file) and messageId, resolves the exact byte range from
// that file's location shard, reads precisely that slice, and re-parses
// it via the existing, unchanged parseMboxMessage -- reusing the
// already-tested MIME parsing rather than duplicating it.
async function retrieveMessage(mboxFile, messageId) {
  const location = getLocation(mboxFile, messageId);
  if (!location) {
    throw new Error(`No location recorded for message ${messageId} in ${mboxFile}`);
  }

  const raw = readExactRange(mboxFile, location.byteOffset, location.byteLength);
  const { message, attachments } = await parseMboxMessage({
    mboxFile, offset: location.byteOffset, raw,
  });

  // A message with no real Message-ID header gets a synthetic one derived
  // from its mbox file + offset (see mboxParser.js), so re-parsing after
  // any physical move (compaction or partitioning) always yields a
  // *different* synthetic id than the one originally stored -- there's no
  // real invariant identity to check there, so this defense-in-depth
  // verification only applies to genuine Message-IDs.
  if (!SYNTHETIC_ID_RE.test(messageId) && message.messageId !== messageId) {
    throw new Error(
      `Location for ${messageId} in ${mboxFile} resolved to a different message `
      + `(${message.messageId}) -- the location shard may be stale`,
    );
  }

  return { message, attachments };
}

// Retrieves one specific attachment's raw content by its stored ordinal
// index (attachmentIndex disambiguates same-named attachments on one
// message -- see mboxParser.js).
async function retrieveAttachmentContent(mboxFile, messageId, attachmentIndex) {
  const { attachments } = await retrieveMessage(mboxFile, messageId);
  const attachment = attachments[attachmentIndex];
  if (!attachment) {
    throw new Error(
      `No attachment at index ${attachmentIndex} for message ${messageId} in ${mboxFile}`,
    );
  }
  return attachment;
}

module.exports = { retrieveMessage, retrieveAttachmentContent };
