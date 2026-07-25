const fs = require('node:fs');
const path = require('node:path');
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
const { upsertLocations } = require('./locationIndex');
const { checkAndPartition } = require('./partitionMbox');

const MESSAGE_TYPES = {
  messageId: VARCHAR,
  mboxFile: VARCHAR,
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

const ATTACHMENT_TYPES = {
  messageId: VARCHAR,
  attachmentIndex: SMALLINT,
  filename: VARCHAR,
  contentType: VARCHAR,
  sizeBytes: BIGINT,
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
       message_id, mbox_file, date_utc, year, month,
       from_addr, to_addr, subject, body_text, body_html, has_attachments
     ) VALUES (
       $messageId, $mboxFile, $dateUtc, $year, $month,
       $fromAddr, $toAddr, $subject, $bodyText, $bodyHtml, $hasAttachments
     )
     ON CONFLICT (message_id) DO NOTHING`,
    {
      messageId: message.messageId,
      mboxFile: message.mboxFile,
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

async function insertAttachment(connection, messageId, attachment) {
  await connection.run(
    `INSERT INTO attachments (message_id, attachment_index, filename, content_type, size_bytes)
     VALUES ($messageId, $attachmentIndex, $filename, $contentType, $sizeBytes)`,
    {
      messageId,
      attachmentIndex: attachment.attachmentIndex,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.size,
    },
    ATTACHMENT_TYPES,
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

async function ingestOneFile(connection, mboxPath) {
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

  // Location entries are collected here and flushed once at the end (see
  // upsertLocations) rather than written per message -- a per-message
  // shard rewrite would be O(n^2) for a file with many new messages.
  const locationEntries = [];

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

    // Upserted unconditionally, regardless of whether insertMessage's own
    // INSERT was a no-op on conflict: this is what closes the latent
    // stale-location bug (see CONTEXT.md) -- a message re-encountered
    // during a full rescan (compaction fallback or a partition rewrite)
    // always gets its current, real location recorded, never silently
    // skipped.
    locationEntries.push({
      messageId: message.messageId,
      byteOffset: message.byteOffset,
      byteLength: message.byteLength,
    });

    for (let j = 0; j < attachments.length; j += 1) {
      // eslint-disable-next-line no-await-in-loop
      await insertAttachment(connection, message.messageId, attachments[j]);
    }
    parsedCount += 1;
  }

  if (locationEntries.length > 0) {
    upsertLocations(mboxPath, locationEntries);
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
    const result = await ingestOneFile(connection, mboxPath);
    const note = result.fallback ? ' (compaction fallback: full rescan)' : '';
    console.log(`${mboxPath}: parsed ${result.parsed} new message(s)${note}`);
  }
}

// Folders eligible for dynamic partitioning once they cross the size
// threshold (see partitionMbox.js). Starts with just Inbox -- the one that
// actually grows forever from live POP3 delivery.
const LIVE_FOLDERS = ['Inbox'];

async function applyPartitionResult(connection, result) {
  const updateTypes = { messageId: VARCHAR, mboxFile: VARCHAR };
  for (let i = 0; i < result.mboxFileUpdates.length; i += 1) {
    const { messageId, mboxFile } = result.mboxFileUpdates[i];
    // eslint-disable-next-line no-await-in-loop
    await connection.run(
      'UPDATE messages SET mbox_file = $mboxFile WHERE message_id = $messageId',
      { messageId, mboxFile },
      updateTypes,
    );
  }

  for (let i = 0; i < result.newIngestState.length; i += 1) {
    const { mboxFile, newSize } = result.newIngestState[i];
    // eslint-disable-next-line no-await-in-loop
    await setIngestState(connection, mboxFile, { lastOffset: newSize, fileSizeAtRun: newSize });
  }
}

// Partitioning is deliberately NOT called from the exported runIngest()
// above -- server.js also calls that over the websocket while serving
// live queries, and a partition rewrite racing against in-flight queries
// resolving message locations would be a real hazard. This only runs from
// the CLI entry point below (`node runIngest.js` / `npm run ingest`).
async function runPartitioning(connection, { dryRun } = {}) {
  for (let i = 0; i < LIVE_FOLDERS.length; i += 1) {
    const mboxPath = path.join(config.mailRootDir, LIVE_FOLDERS[i]);
    const paths = {
      manifestPath: config.manifestPath,
      backupDir: config.partitionBackupDir,
      journalDir: config.partitionJournalDir,
    };
    // eslint-disable-next-line no-await-in-loop
    const result = await checkAndPartition(mboxPath, config.profileDir, paths, { dryRun });

    if (result.partitioned) {
      // eslint-disable-next-line no-await-in-loop
      await applyPartitionResult(connection, result);
      console.log(`Partitioned ${mboxPath}.`);
    } else if (result.dryRun) {
      console.log(`[dry run] ${mboxPath}: would partition (see plan above).`);
    } else {
      console.log(`${mboxPath}: not partitioned (${result.reason}).`);
    }
  }
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  runIngest()
    .then(async () => {
      const connection = await getConnection(config.dbPath);
      await runPartitioning(connection, { dryRun });
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runIngest, ingestOneFile };
