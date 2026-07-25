const fs = require('node:fs');
const {
  VARCHAR, SMALLINT, BIGINT,
} = require('@duckdb/node-api');
const config = require('../config');
const { getConnection } = require('../duckdbClient');
const { discoverMboxFiles } = require('./discoverMboxFiles');
const { splitMboxMessages, parseMboxMessage } = require('./mboxParser');
const { upsertLocations } = require('./locationIndex');

// One-off migration: moves byte_offset out of mail.duckdb's `messages`
// table into per-mbox-file `.locations.csv` shards, and rebuilds
// `attachments` with attachment_index instead of a filesystem blob_path.
//
// This is deliberately NOT a mechanical column copy. A latent bug (see
// CONTEXT.md / the approved plan) meant a real Thunderbird compaction could
// already have silently left a stale byte_offset in the database before
// this fix existed, and there is no way to tell from the stored data alone
// whether that has happened. So this re-scans every mbox file fresh from
// offset 0 and cross-validates the result against what's currently stored
// before touching the schema at all -- any disagreement stops the script
// for manual review rather than silently proceeding.
//
// attachments/ (the old content-hash blob directory) is left on disk
// untouched; deleting it is a separate, later, explicitly-confirmed step.

const ATTACHMENT_TYPES = {
  messageId: VARCHAR,
  attachmentIndex: SMALLINT,
  filename: VARCHAR,
  contentType: VARCHAR,
  sizeBytes: BIGINT,
};

async function scanFile(mboxPath) {
  const buffer = fs.readFileSync(mboxPath);
  const rawMessages = splitMboxMessages(buffer, 0);

  const locationEntries = [];
  const attachmentsByMessageId = new Map();

  for (let i = 0; i < rawMessages.length; i += 1) {
    const rawMessage = rawMessages[i];
    // eslint-disable-next-line no-await-in-loop
    const { message, attachments } = await parseMboxMessage({
      mboxFile: mboxPath,
      offset: rawMessage.offset,
      raw: rawMessage.raw,
    });

    locationEntries.push({
      messageId: message.messageId,
      byteOffset: message.byteOffset,
      byteLength: message.byteLength,
    });

    if (attachments.length > 0) {
      attachmentsByMessageId.set(message.messageId, attachments);
    }
  }

  return { locationEntries, attachmentsByMessageId };
}

async function scanAllFiles(mboxFiles) {
  const freshLocationsByMessageId = new Map();
  const freshAttachmentsByMessageId = new Map();

  for (let i = 0; i < mboxFiles.length; i += 1) {
    const mboxPath = mboxFiles[i];
    // eslint-disable-next-line no-await-in-loop
    const { locationEntries, attachmentsByMessageId } = await scanFile(mboxPath);

    // First-write-wins, matching the database's own ON CONFLICT (message_id)
    // DO NOTHING semantics from the original ingest: the same Message-ID
    // can genuinely appear in two physical files (e.g. a sent message also
    // filed as a copy in a correspondent folder) -- whichever file
    // discoverMboxFiles visits first is the one the database already
    // treats as authoritative, so the fresh scan must agree rather than
    // overwrite it with whatever is found later.
    locationEntries.forEach((entry) => {
      if (!freshLocationsByMessageId.has(entry.messageId)) {
        freshLocationsByMessageId.set(entry.messageId, { mboxFile: mboxPath, ...entry });
      }
    });
    Array.from(attachmentsByMessageId.entries()).forEach(([messageId, attachments]) => {
      if (!freshAttachmentsByMessageId.has(messageId)) {
        freshAttachmentsByMessageId.set(messageId, attachments);
      }
    });

    if (locationEntries.length > 0) {
      upsertLocations(mboxPath, locationEntries);
    }
    console.log(`  ${mboxPath}: ${locationEntries.length} message(s) scanned`);
  }

  return { freshLocationsByMessageId, freshAttachmentsByMessageId };
}

function crossValidate(existingRows, freshLocationsByMessageId) {
  const mismatches = [];
  const notFound = [];

  existingRows.forEach((row) => {
    const fresh = freshLocationsByMessageId.get(row.message_id);
    if (!fresh) {
      notFound.push(row.message_id);
    } else if (fresh.mboxFile !== row.mbox_file) {
      mismatches.push({ messageId: row.message_id, stored: row.mbox_file, fresh: fresh.mboxFile });
    }
  });

  return { mismatches, notFound };
}

// Builds the rebuilt attachments data into a fresh `attachments_new` table
// rather than overwriting `attachments` directly -- so a failed
// verification never destroys the ability to compare against the original
// table. The caller swaps it into place only after `missing` is confirmed
// empty.
//
// A lower row count than the original table is expected and healthy, not
// a red flag: the original `insertAttachment` was never guarded the way
// `insertMessage`'s `ON CONFLICT DO NOTHING` is, so any message
// re-encountered during a compaction-triggered full rescan (or existing
// as a genuine cross-file duplicate, e.g. a sent message also filed as a
// copy in a correspondent folder) had its attachments inserted again each
// time. This fresh, single-pass rebuild can't reproduce that duplication.
async function rebuildAttachments(connection, freshAttachmentsByMessageId) {
  await connection.run('DROP TABLE IF EXISTS attachments_new');
  await connection.run(`
    CREATE TABLE attachments_new (
      message_id       VARCHAR NOT NULL,
      attachment_index SMALLINT NOT NULL,
      filename         VARCHAR,
      content_type     VARCHAR,
      size_bytes       BIGINT
    )
  `);

  let insertedCount = 0;
  const entries = Array.from(freshAttachmentsByMessageId.entries());
  for (let i = 0; i < entries.length; i += 1) {
    const [messageId, attachments] = entries[i];
    for (let j = 0; j < attachments.length; j += 1) {
      const attachment = attachments[j];
      // eslint-disable-next-line no-await-in-loop
      await connection.run(
        `INSERT INTO attachments_new
           (message_id, attachment_index, filename, content_type, size_bytes)
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
      insertedCount += 1;
    }
  }

  // The real correctness gate: no message currently marked
  // has_attachments = true may end up with zero rows in the rebuild.
  const missingReader = await connection.runAndReadAll(`
    SELECT m.message_id
    FROM messages m
    WHERE m.has_attachments = true
      AND NOT EXISTS (SELECT 1 FROM attachments_new a WHERE a.message_id = m.message_id)
  `);
  const missing = missingReader.getRowObjectsJS().map((row) => row.message_id);

  return { insertedCount, missing };
}

async function main() {
  const connection = await getConnection(config.dbPath);
  const mboxFiles = discoverMboxFiles(config.mailRootDir);

  console.log(`Scanning ${mboxFiles.length} mbox file(s) fresh from offset 0...`);
  const { freshLocationsByMessageId, freshAttachmentsByMessageId } = await scanAllFiles(mboxFiles);

  console.log('Cross-validating against messages.mbox_file...');
  const existingReader = await connection.runAndReadAll(
    'SELECT message_id, mbox_file FROM messages',
  );
  const existingRows = existingReader.getRowObjectsJS();
  const { mismatches, notFound } = crossValidate(existingRows, freshLocationsByMessageId);

  if (mismatches.length > 0 || notFound.length > 0) {
    console.error('Cross-validation FAILED.');
    console.error(`  ${mismatches.length} message(s) with a different mbox_file than stored:`);
    mismatches.slice(0, 20).forEach((m) => {
      console.error(`    ${m.messageId}: stored=${m.stored} fresh=${m.fresh}`);
    });
    console.error(`  ${notFound.length} message(s) in the database not found by the fresh scan:`);
    notFound.slice(0, 20).forEach((id) => console.error(`    ${id}`));
    console.error('Stopping without touching the schema. Investigate before re-running.');
    process.exitCode = 1;
    return;
  }
  console.log(`Cross-validation passed: all ${existingRows.length} existing messages match.`);

  console.log('Rebuilding attachments table...');
  const existingCountReader = await connection.runAndReadAll(
    'SELECT COUNT(*) AS n FROM attachments',
  );
  const existingCount = Number(existingCountReader.getRowObjectsJS()[0].n);
  const { insertedCount, missing } = await rebuildAttachments(
    connection,
    freshAttachmentsByMessageId,
  );

  if (missing.length > 0) {
    console.error(
      `${missing.length} message(s) marked has_attachments=true would lose `
      + 'ALL attachments in the rebuild:',
    );
    missing.slice(0, 20).forEach((id) => console.error(`    ${id}`));
    console.error('Stopping without touching the schema. attachments_new left for inspection.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `Rebuilt attachments: ${insertedCount} row(s) (was ${existingCount}). A lower count here `
    + 'is expected and healthy -- see the comment on rebuildAttachments for why.',
  );

  console.log('Swapping in the verified attachments table...');
  await connection.run('DROP TABLE attachments');
  await connection.run('ALTER TABLE attachments_new RENAME TO attachments');

  console.log('Dropping messages.byte_offset...');
  await connection.run('ALTER TABLE messages DROP COLUMN byte_offset');

  console.log('Migration complete. attachments/ directory left on disk untouched.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
