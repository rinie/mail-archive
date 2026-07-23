const fs = require('node:fs');
const {
  VARCHAR, BIGINT, SMALLINT, TIMESTAMP, BOOLEAN,
} = require('@duckdb/node-api');
const config = require('../config');
const { getConnection, toTimestampParam } = require('../duckdbClient');
const { discoverMboxFiles } = require('./discoverMboxFiles');
const { splitMboxMessages, parseMboxMessage } = require('./mboxParser');
const {
  getIngestState,
  setIngestState,
  needsCompactionFallback,
} = require('./ingestState');
const { writeAttachmentBlob } = require('./attachmentStore');

const MESSAGE_TYPES = {
  messageId: VARCHAR,
  mboxFile: VARCHAR,
  byteOffset: BIGINT,
  dateUtc: TIMESTAMP,
  year: SMALLINT,
  month: SMALLINT,
  fromAddr: VARCHAR,
  toAddr: VARCHAR,
  subject: VARCHAR,
  bodyText: VARCHAR,
  bodyHtml: VARCHAR,
  hasAttachments: BOOLEAN,
};

// mailparser's output shape has surprised us once already (arrays where a
// single AddressObject was expected); DuckDB's VARCHAR binder accepts
// `string` or `null` but throws on `undefined`, so normalize defensively
// here rather than trust every field stays a plain string forever.
function orNull(value) {
  return value === undefined ? null : value;
}

async function insertMessage(connection, message) {
  await connection.run(
    `INSERT INTO messages (
       message_id, mbox_file, byte_offset, date_utc, year, month,
       from_addr, to_addr, subject, body_text, body_html, has_attachments
     ) VALUES (
       $messageId, $mboxFile, $byteOffset, $dateUtc, $year, $month,
       $fromAddr, $toAddr, $subject, $bodyText, $bodyHtml, $hasAttachments
     )
     ON CONFLICT (message_id) DO NOTHING`,
    {
      messageId: message.messageId,
      mboxFile: message.mboxFile,
      byteOffset: message.byteOffset,
      dateUtc: toTimestampParam(message.dateUtc),
      year: message.year,
      month: message.month,
      fromAddr: orNull(message.fromAddr),
      toAddr: orNull(message.toAddr),
      subject: orNull(message.subject),
      bodyText: orNull(message.bodyText),
      bodyHtml: orNull(message.bodyHtml),
      hasAttachments: message.hasAttachments,
    },
    MESSAGE_TYPES,
  );
}

async function insertAttachment(connection, messageId, attachment, blobPath) {
  await connection.run(
    `INSERT INTO attachments (message_id, filename, content_type, size_bytes, blob_path)
     VALUES ($messageId, $filename, $contentType, $sizeBytes, $blobPath)`,
    {
      messageId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
      blobPath,
    },
    {
      messageId: VARCHAR,
      filename: VARCHAR,
      contentType: VARCHAR,
      sizeBytes: BIGINT,
      blobPath: VARCHAR,
    },
  );
}

function readTail(mboxPath, startOffset, currentSize) {
  const length = currentSize - startOffset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(mboxPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, startOffset);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

async function ingestOneFile(connection, mboxPath, attachmentsDir) {
  const currentSize = fs.statSync(mboxPath).size;
  if (currentSize === 0) return { parsed: 0, fallback: false };

  const state = await getIngestState(connection, mboxPath);
  const fallback = needsCompactionFallback(mboxPath, state);
  const startOffset = fallback || !state ? 0 : state.lastOffset;

  if (startOffset >= currentSize) {
    return { parsed: 0, fallback };
  }

  const buffer = readTail(mboxPath, startOffset, currentSize);
  const rawMessages = splitMboxMessages(buffer, startOffset);

  // Sequential on purpose: keeps memory bounded (one message decoded/
  // written at a time) and preserves file order for easier debugging.
  let parsedCount = 0;
  for (let i = 0; i < rawMessages.length; i += 1) {
    const rawMessage = rawMessages[i];
    // eslint-disable-next-line no-await-in-loop
    const { message, attachments } = await parseMboxMessage({
      mboxFile: mboxPath,
      offset: rawMessage.offset,
      raw: rawMessage.raw,
    });

    // eslint-disable-next-line no-await-in-loop
    await insertMessage(connection, message);

    for (let j = 0; j < attachments.length; j += 1) {
      const attachment = attachments[j];
      const blobPath = writeAttachmentBlob(attachmentsDir, attachment.content);
      // eslint-disable-next-line no-await-in-loop
      await insertAttachment(connection, message.messageId, attachment, blobPath);
    }
    parsedCount += 1;
  }

  await setIngestState(connection, mboxPath, {
    lastOffset: currentSize,
    fileSizeAtRun: currentSize,
  });

  return { parsed: parsedCount, fallback };
}

async function runIngest() {
  const connection = await getConnection(config.dbPath);
  const mboxFiles = discoverMboxFiles(config.mailRootDir);

  console.log(`Discovered ${mboxFiles.length} mbox file(s) under ${config.mailRootDir}`);

  for (let i = 0; i < mboxFiles.length; i += 1) {
    const mboxPath = mboxFiles[i];
    // eslint-disable-next-line no-await-in-loop
    const result = await ingestOneFile(connection, mboxPath, config.attachmentsDir);
    const note = result.fallback ? ' (compaction fallback: full rescan)' : '';
    console.log(`${mboxPath}: parsed ${result.parsed} new message(s)${note}`);
  }
}

if (require.main === module) {
  runIngest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { runIngest };
