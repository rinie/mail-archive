const fs = require('node:fs');
const path = require('node:path');
const { VARCHAR } = require('@duckdb/node-api');
const {
  assertThunderbirdNotRunning, scanAndParse, messageIdSet, setsEqual, concatRaw,
} = require('./partitionMbox');
const { upsertLocations, deleteShard } = require('./locationIndex');
const { readManifestRows, removeManifestRows } = require('./partitionManifest');
const config = require('../config');
const { getConnection } = require('../duckdbClient');
const { setIngestState, deleteIngestState } = require('./ingestState');

// Merges every partition-created archive file for one logical folder (e.g.
// Inbox.sbd/archive-2007 .. archive-2025, as recorded in
// partition_manifest.csv) back into the live mbox file they were split out
// of -- the exact inverse of partitionMbox.js's executePartition. This is a
// manual, user-invoked operation with no automatic trigger (there's no
// "too small, please merge" threshold the way there's a "too big, please
// partition" one), so it only runs from this file's own CLI entry point
// below, never from runIngest.js or any automatic flow. Same
// non-destructive-until-independently-verified discipline as partitioning:
// nothing is deleted or renamed into place until a re-scan of the merged
// result confirms no message was lost or duplicated.

function yearFromArchivePath(archivePath) {
  const match = path.basename(archivePath).match(/^archive-(\d+)$/);
  return match ? Number(match[1]) : null;
}

// ---- Planning ----

function planUnpartition(mboxPath, manifestPath) {
  const archivePaths = readManifestRows(manifestPath)
    .filter((row) => row.logicalFolder === mboxPath)
    .map((row) => row.physicalPath);

  if (archivePaths.length === 0) {
    return {
      eligible: false,
      reason: `no partition_manifest.csv entries for logical folder ${mboxPath}`,
    };
  }

  const missing = archivePaths.filter((archivePath) => !fs.existsSync(archivePath));
  if (missing.length > 0) {
    throw new Error(
      `Manifest references archive file(s) that no longer exist on disk: ${missing.join(', ')}`,
    );
  }

  // Oldest first, then the live file's own current content last -- purely
  // for a readable resulting file; mbox validity doesn't depend on order.
  archivePaths.sort((a, b) => (yearFromArchivePath(a) ?? 0) - (yearFromArchivePath(b) ?? 0));

  return {
    eligible: true, mboxPath, archivePaths, sbdDir: `${mboxPath}.sbd`,
  };
}

function logUnpartitionPlan(plan) {
  console.log(`Unpartition plan for ${plan.mboxPath}:`);
  plan.archivePaths.forEach((archivePath) => console.log(`  merge in: ${archivePath}`));
  console.log(`  (plus ${plan.mboxPath}'s own current content, appended last)`);
}

// ---- Execution ----

async function executeUnpartition(plan, profileDir, paths) {
  assertThunderbirdNotRunning(profileDir);

  fs.mkdirSync(paths.backupDir, { recursive: true });
  fs.mkdirSync(paths.journalDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 1. Backup every file being read/replaced, size-verified.
  [plan.mboxPath, ...plan.archivePaths].forEach((file) => {
    const backupPath = path.join(paths.backupDir, `${path.basename(file)}.${timestamp}.bak`);
    fs.copyFileSync(file, backupPath);
    if (fs.statSync(backupPath).size !== fs.statSync(file).size) {
      throw new Error(`Backup of ${file} did not match original size -- aborting.`);
    }
  });

  // 2. Scan every source file independently.
  const liveEntries = await scanAndParse(plan.mboxPath);
  const archiveEntriesByPath = {};
  for (let i = 0; i < plan.archivePaths.length; i += 1) {
    const archivePath = plan.archivePaths[i];
    // eslint-disable-next-line no-await-in-loop
    archiveEntriesByPath[archivePath] = await scanAndParse(archivePath);
  }

  const expectedIds = new Set(messageIdSet(liveEntries));
  plan.archivePaths.forEach((archivePath) => {
    messageIdSet(archiveEntriesByPath[archivePath]).forEach((id) => expectedIds.add(id));
  });

  // 3. Write to a .tmp sibling -- never modify the live file directly.
  const orderedEntries = plan.archivePaths
    .flatMap((archivePath) => archiveEntriesByPath[archivePath])
    .concat(liveEntries);
  const tmpPath = `${plan.mboxPath}.tmp`;
  fs.writeFileSync(tmpPath, concatRaw(orderedEntries));

  // 4. Independently re-scan the .tmp file and confirm its message-id set
  // exactly equals the union of every source file's set -- the single most
  // important integrity gate. Abort (leaving every original untouched) on
  // any mismatch.
  const mergedEntries = await scanAndParse(tmpPath);
  if (!setsEqual(messageIdSet(mergedEntries), expectedIds)) {
    throw new Error(`Verification failed: ${tmpPath} does not match the expected merged set.`);
  }

  // 5. Write a rename journal before the rename.
  const journalPath = path.join(paths.journalDir, `unpartition-${timestamp}.json`);
  const writeJournal = (completed) => fs.writeFileSync(
    journalPath,
    JSON.stringify({ rename: { from: tmpPath, to: plan.mboxPath }, completed }, null, 2),
    'utf8',
  );
  writeJournal(false);

  // 6. Rename the merged .tmp into place as the live file.
  fs.renameSync(tmpPath, plan.mboxPath);
  writeJournal(true);

  // 7. Update the live file's location shard with every message's new
  // offset, as a side effect of the re-scan above -- covers both messages
  // that were already there and ones merged in from an archive file.
  const toLocationEntries = (entries) => entries.map((entry) => ({
    messageId: entry.message.messageId,
    byteOffset: entry.message.byteOffset,
    byteLength: entry.message.byteLength,
  }));
  upsertLocations(plan.mboxPath, toLocationEntries(mergedEntries));

  // 8. Only after the rename and location-shard update have committed:
  // delete the now-fully-merged archive files, their location shards, and
  // their manifest rows.
  plan.archivePaths.forEach((archivePath) => {
    fs.unlinkSync(archivePath);
    deleteShard(archivePath);
  });
  removeManifestRows(paths.manifestPath, plan.archivePaths);

  // 9. Delete .msf last -- Thunderbird regenerates it automatically on next
  // open. Archive files' own .msf (if any) is harmless to also remove since
  // the mbox itself is already gone.
  [plan.mboxPath, ...plan.archivePaths].forEach((mboxFile) => {
    const msfPath = `${mboxFile}.msf`;
    if (fs.existsSync(msfPath)) fs.unlinkSync(msfPath);
  });

  // Remove the now-empty .sbd directory, but only if nothing unexpected is
  // left in it -- a non-empty dir means something else genuinely lives
  // there (e.g. a real Thunderbird subfolder), so leave it alone.
  if (fs.existsSync(plan.sbdDir) && fs.readdirSync(plan.sbdDir).length === 0) {
    fs.rmdirSync(plan.sbdDir);
  }

  // 10. The caller updates messages.mbox_file for every message that came
  // from a merged archive file, and removes ingest_state rows for the
  // now-deleted archive files.
  const mboxFileUpdates = [];
  plan.archivePaths.forEach((archivePath) => {
    archiveEntriesByPath[archivePath].forEach((entry) => {
      mboxFileUpdates.push({ messageId: entry.message.messageId, mboxFile: plan.mboxPath });
    });
  });

  return {
    mboxFileUpdates,
    newIngestState: [{ mboxFile: plan.mboxPath, newSize: fs.statSync(plan.mboxPath).size }],
    removedIngestStateFiles: plan.archivePaths,
  };
}

// Top-level entry point: no size threshold (this is a manual, deliberate
// operation, not an automatic one) -- plans, logs, and (unless dryRun)
// executes. Returns { unpartitioned: false } if there's nothing to merge.
async function unpartitionFolder(mboxPath, profileDir, paths, { dryRun = false } = {}) {
  const plan = planUnpartition(mboxPath, paths.manifestPath);
  if (!plan.eligible) return { unpartitioned: false, reason: plan.reason };

  logUnpartitionPlan(plan);

  if (dryRun) return { unpartitioned: false, dryRun: true, plan };

  const result = await executeUnpartition(plan, profileDir, paths);
  return { unpartitioned: true, plan, ...result };
}

// ---- CLI entry point -- deliberately separate from runIngest.js. Run by
// hand only: `node backend/ingest/unpartitionMbox.js [--dry-run]`. ----

if (require.main === module) {
  const LIVE_FOLDERS = ['Inbox'];

  const applyUnpartitionResult = async (connection, result) => {
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
    for (let i = 0; i < result.removedIngestStateFiles.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await deleteIngestState(connection, result.removedIngestStateFiles[i]);
    }
  };

  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    const connection = await getConnection(config.dbPath);
    for (let i = 0; i < LIVE_FOLDERS.length; i += 1) {
      const mboxPath = path.join(config.mailRootDir, LIVE_FOLDERS[i]);
      const paths = {
        manifestPath: config.manifestPath,
        backupDir: config.partitionBackupDir,
        journalDir: config.partitionJournalDir,
      };
      // eslint-disable-next-line no-await-in-loop
      const result = await unpartitionFolder(mboxPath, config.profileDir, paths, { dryRun });
      if (result.unpartitioned) {
        // eslint-disable-next-line no-await-in-loop
        await applyUnpartitionResult(connection, result);
        console.log(`Unpartitioned ${mboxPath}.`);
      } else if (result.dryRun) {
        console.log(`[dry run] ${mboxPath}: would unpartition (see plan above).`);
      } else {
        console.log(`${mboxPath}: not unpartitioned (${result.reason}).`);
      }
    }
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  planUnpartition, logUnpartitionPlan, executeUnpartition, unpartitionFolder,
};
