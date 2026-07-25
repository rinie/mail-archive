const fs = require('node:fs');
const crypto = require('node:crypto');
const { getConnection } = require('../duckdbClient');
const config = require('../config');
const { retrieveMessage } = require('./messageLocator');

// One-off verification: for a random sample of real messages with
// attachments, fetches each attachment via the new on-demand
// messageLocator path (byte-range seek into the mbox + re-parse) and
// compares its SHA-256 against the still-on-disk file in the old
// content-hash blob store (attachments/<hash prefix>/<hash>) -- the
// content-addressed naming means a matching, existing file at that exact
// path is itself proof of byte-for-byte identity, but this also reads and
// compares the bytes directly as a defense-in-depth check. Run this before
// attachments/ is ever considered for deletion.

const SAMPLE_SIZE = 30;

function blobPathFor(hash) {
  return `${config.attachmentsDir}/${hash.slice(0, 2)}/${hash}`;
}

async function verifyOne(mboxFile, messageId) {
  const { attachments } = await retrieveMessage(mboxFile, messageId);
  const results = [];

  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i];
    const hash = crypto.createHash('sha256').update(attachment.content).digest('hex');
    const blobPath = blobPathFor(hash);

    if (!fs.existsSync(blobPath)) {
      results.push({
        ok: false, messageId, attachment, reason: `no matching blob at ${blobPath}`,
      });
    } else {
      const originalBytes = fs.readFileSync(blobPath);
      const ok = originalBytes.equals(attachment.content);
      results.push({
        ok,
        messageId,
        attachment,
        reason: ok ? null : `byte content differs from ${blobPath}`,
      });
    }
  }

  return results;
}

async function main() {
  const connection = await getConnection(config.dbPath);

  const reader = await connection.runAndReadAll(
    `SELECT message_id, mbox_file FROM messages
     WHERE has_attachments = true
     ORDER BY random()
     LIMIT ${SAMPLE_SIZE}`,
  );
  const rows = reader.getRowObjectsJS();
  console.log(`Verifying ${rows.length} sampled message(s) with attachments...`);

  const allResults = [];
  for (let i = 0; i < rows.length; i += 1) {
    const { message_id: messageId, mbox_file: mboxFile } = rows[i];
    // eslint-disable-next-line no-await-in-loop
    const results = await verifyOne(mboxFile, messageId);
    allResults.push(...results);
  }

  allResults.forEach((result) => {
    if (result.ok) {
      console.log(
        `  OK: ${result.messageId} attachment #${result.attachment.attachmentIndex} `
        + `("${result.attachment.filename}", ${result.attachment.content.length} bytes)`,
      );
    } else {
      console.error(
        `  MISMATCH: ${result.messageId} attachment #${result.attachment.attachmentIndex} `
        + `("${result.attachment.filename}") -- ${result.reason}`,
      );
    }
  });

  const failedCount = allResults.filter((r) => !r.ok).length;
  const passedCount = allResults.length - failedCount;
  console.log(`\n${passedCount}/${allResults.length} attachment(s) verified byte-for-byte.`);
  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
