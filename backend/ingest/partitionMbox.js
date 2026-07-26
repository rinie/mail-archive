const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { splitMboxMessages, parseMboxMessage } = require('./mboxParser');
const { upsertLocations } = require('./locationIndex');
const { appendManifestRow } = require('./partitionManifest');

// Moves messages dated to a fully-closed past calendar year out of a live,
// growing mbox file (e.g. Inbox) into per-year Inbox.sbd/archive-<year>
// files, so the live file stops growing forever while Thunderbird keeps
// using the same profile to fetch new mail. See CONTEXT.md / the approved
// plan for the full design and why each guardrail below exists -- this
// physically rewrites a live, irreplaceable mail store, so every step is
// non-destructive-until-independently-verified.

const SIZE_THRESHOLD_BYTES = 300 * 1024 * 1024;

// ---- Thunderbird-running detection: fail closed on any ambiguity ----

function isThunderbirdRunningViaTasklist() {
  try {
    const output = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq thunderbird.exe'],
      { encoding: 'utf8' },
    );
    return /thunderbird\.exe/i.test(output);
  } catch {
    return true; // couldn't run/parse tasklist -- assume running
  }
}

// Windows keeps parent.lock's mere *existence* even after Thunderbird
// closes, so only an actual sharing violation on open (not existence) is
// a valid "still running" signal.
function isThunderbirdRunningViaLockFile(profileDir) {
  const lockPath = path.join(profileDir, 'parent.lock');
  if (!fs.existsSync(lockPath)) return false;
  let fd;
  try {
    fd = fs.openSync(lockPath, 'r+');
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertThunderbirdNotRunning(profileDir) {
  if (isThunderbirdRunningViaTasklist()) {
    throw new Error(
      'Thunderbird appears to be running (tasklist found thunderbird.exe). '
      + 'Close it completely before partitioning.',
    );
  }
  if (isThunderbirdRunningViaLockFile(profileDir)) {
    throw new Error(
      `${profileDir}\\parent.lock could not be opened for read+write -- `
      + 'something has the profile locked. Close Thunderbird before partitioning.',
    );
  }
}

// ---- Scanning / classification ----

async function scanAndParse(mboxPath) {
  const buffer = fs.readFileSync(mboxPath);
  const rawMessages = splitMboxMessages(buffer, 0);
  const parsed = [];
  for (let i = 0; i < rawMessages.length; i += 1) {
    const rawMessage = rawMessages[i];
    // eslint-disable-next-line no-await-in-loop
    const { message } = await parseMboxMessage({
      mboxFile: mboxPath, offset: rawMessage.offset, raw: rawMessage.raw,
    });
    parsed.push({ raw: rawMessage.raw, message });
  }
  return parsed;
}

function messageIdSet(entries) {
  return new Set(entries.map((entry) => entry.message.messageId));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  return Array.from(a).every((item) => b.has(item));
}

// Splits a folder's messages into "retain" (current year, or an
// unparseable date -- never guess a target year for those) and
// "relocate", grouped by year, for every fully-closed past year.
function classify(entries, currentYear) {
  const retain = [];
  const relocateByYear = new Map();

  entries.forEach((entry) => {
    const { year } = entry.message;
    if (year !== null && year < currentYear) {
      if (!relocateByYear.has(year)) relocateByYear.set(year, []);
      relocateByYear.get(year).push(entry);
    } else {
      retain.push(entry);
    }
  });

  return { retain, relocateByYear };
}

function concatRaw(entries) {
  return Buffer.concat(entries.map((entry) => entry.raw));
}

// ---- The partition operation for one live folder ----

async function planPartition(mboxPath, currentYear) {
  const entries = await scanAndParse(mboxPath);
  const { retain, relocateByYear } = classify(entries, currentYear);

  const sbdDir = `${mboxPath}.sbd`;
  const targets = Array.from(relocateByYear.entries()).map(([year, yearEntries]) => ({
    year,
    archivePath: path.join(sbdDir, `archive-${year}`),
    entries: yearEntries,
    isNewFile: !fs.existsSync(path.join(sbdDir, `archive-${year}`)),
  }));

  return {
    mboxPath, sbdDir, retain, targets,
  };
}

function logPlan(plan) {
  console.log(`Partition plan for ${plan.mboxPath}:`);
  console.log(`  retain: ${plan.retain.length} message(s) (current year + unparseable dates)`);
  plan.targets.forEach((target) => {
    const verb = target.isNewFile ? 'new file' : 'appending';
    console.log(`  -> ${target.archivePath}: ${target.entries.length} message(s) (${verb})`);
  });
}

async function executePartition(plan, profileDir, paths) {
  assertThunderbirdNotRunning(profileDir);

  fs.mkdirSync(paths.backupDir, { recursive: true });
  fs.mkdirSync(paths.journalDir, { recursive: true });
  fs.mkdirSync(plan.sbdDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 2. Backup Inbox and any target file being appended to, size-verified.
  const inboxBackupName = `${path.basename(plan.mboxPath)}.${timestamp}.bak`;
  const inboxBackupPath = path.join(paths.backupDir, inboxBackupName);
  fs.copyFileSync(plan.mboxPath, inboxBackupPath);
  const originalSize = fs.statSync(plan.mboxPath).size;
  if (fs.statSync(inboxBackupPath).size !== originalSize) {
    throw new Error(`Backup of ${plan.mboxPath} did not match original size -- aborting.`);
  }
  plan.targets.filter((target) => !target.isNewFile).forEach((target) => {
    const backupName = `${path.basename(target.archivePath)}.${timestamp}.bak`;
    fs.copyFileSync(target.archivePath, path.join(paths.backupDir, backupName));
  });

  // 3. Write to .tmp siblings -- never modify the real files directly.
  const inboxTmpPath = `${plan.mboxPath}.tmp`;
  fs.writeFileSync(inboxTmpPath, concatRaw(plan.retain));

  plan.targets.forEach((target) => {
    const tmpPath = `${target.archivePath}.tmp`;
    const existingBuffer = target.isNewFile ? Buffer.alloc(0) : fs.readFileSync(target.archivePath);
    fs.writeFileSync(tmpPath, Buffer.concat([existingBuffer, concatRaw(target.entries)]));
  });

  // 4. Independently re-scan every .tmp file and confirm its message-id
  // set exactly matches what was intended -- the single most important
  // integrity gate. Abort (leaving originals untouched) on any mismatch.
  const inboxTmpEntries = await scanAndParse(inboxTmpPath);
  if (!setsEqual(messageIdSet(inboxTmpEntries), messageIdSet(plan.retain))) {
    throw new Error(`Verification failed: ${inboxTmpPath} does not match the retained set.`);
  }

  const targetVerifications = [];
  for (let i = 0; i < plan.targets.length; i += 1) {
    const target = plan.targets[i];
    const tmpPath = `${target.archivePath}.tmp`;
    // eslint-disable-next-line no-await-in-loop
    const tmpEntries = await scanAndParse(tmpPath);
    let expected = messageIdSet(target.entries);
    if (!target.isNewFile) {
      // eslint-disable-next-line no-await-in-loop
      const preExisting = await scanAndParse(target.archivePath);
      expected = new Set([...messageIdSet(preExisting), ...expected]);
    }
    if (!setsEqual(messageIdSet(tmpEntries), expected)) {
      throw new Error(`Verification failed: ${tmpPath} does not match the intended set.`);
    }
    targetVerifications.push({ target, tmpEntries });
  }

  // 5. Write a rename journal before the first rename -- a crash between
  // the (non-atomic-as-a-pair) renames below is then detectable/resumable
  // rather than silently leaving files inconsistently paired.
  const journalPath = path.join(paths.journalDir, `${timestamp}.json`);
  const renames = [{ from: inboxTmpPath, to: plan.mboxPath }].concat(
    plan.targets.map((target) => ({ from: `${target.archivePath}.tmp`, to: target.archivePath })),
  );
  fs.writeFileSync(journalPath, JSON.stringify({ renames, completed: [] }, null, 2), 'utf8');

  // 6. Rename .tmp files into place.
  renames.forEach((rename) => {
    fs.renameSync(rename.from, rename.to);
  });
  fs.writeFileSync(journalPath, JSON.stringify({ renames, completed: renames }, null, 2), 'utf8');

  // 7. Update location shards. The rewrite already knows every message's
  // exact new offset/length as a side effect of the re-scan above -- both
  // retained messages (whose offsets shift in the rewritten Inbox once
  // earlier messages are removed) and relocated ones need this, or a
  // retained message keeps a stale offset forever (the exact bug this
  // whole exercise exists to close -- see CONTEXT.md).
  const toLocationEntries = (entries) => entries.map((entry) => ({
    messageId: entry.message.messageId,
    byteOffset: entry.message.byteOffset,
    byteLength: entry.message.byteLength,
  }));
  upsertLocations(plan.mboxPath, toLocationEntries(inboxTmpEntries));

  // 8. Update the messages.mbox_file cache for every relocated message
  // (returned for the caller to apply via its own DB connection).
  const mboxFileUpdates = [];
  targetVerifications.forEach(({ target, tmpEntries }) => {
    upsertLocations(target.archivePath, toLocationEntries(tmpEntries));
    target.entries.forEach((entry) => {
      mboxFileUpdates.push({ messageId: entry.message.messageId, mboxFile: target.archivePath });
    });

    if (target.isNewFile) {
      appendManifestRow(paths.manifestPath, target.archivePath, plan.mboxPath);
    }
  });

  // 10. Delete .msf last, only after both renames are confirmed
  // committed -- Thunderbird regenerates it automatically on next open.
  const touchedFiles = [plan.mboxPath, ...plan.targets.map((target) => target.archivePath)];
  touchedFiles.forEach((mboxFile) => {
    const msfPath = `${mboxFile}.msf`;
    if (fs.existsSync(msfPath)) fs.unlinkSync(msfPath);
  });

  // 9. The caller updates ingest_state for each of these to
  // {lastOffset: newSize, fileSizeAtRun: newSize} so the next ordinary
  // ingest run doesn't see a shrunk Inbox and trigger a redundant
  // compaction-fallback rescan.
  const newIngestState = touchedFiles.map((mboxFile) => ({
    mboxFile,
    newSize: fs.statSync(mboxFile).size,
  }));

  return { mboxFileUpdates, newIngestState };
}

// Top-level entry point: checks the size threshold, plans, logs, and (
// unless dryRun) executes. Returns { partitioned: false } if the file is
// under threshold or has nothing eligible to relocate, otherwise the
// executePartition result merged with { partitioned: true }.
async function checkAndPartition(mboxPath, profileDir, paths, { dryRun = false } = {}) {
  const { size } = fs.statSync(mboxPath);
  if (size < SIZE_THRESHOLD_BYTES) {
    return { partitioned: false, reason: `${mboxPath} (${size} bytes) is under the threshold` };
  }

  const currentYear = new Date().getFullYear();
  const plan = await planPartition(mboxPath, currentYear);

  if (plan.targets.length === 0) {
    return { partitioned: false, reason: `${mboxPath} has no fully-closed-year messages` };
  }

  logPlan(plan);

  if (dryRun) {
    return { partitioned: false, dryRun: true, plan };
  }

  const result = await executePartition(plan, profileDir, paths);
  return { partitioned: true, plan, ...result };
}

module.exports = {
  SIZE_THRESHOLD_BYTES,
  assertThunderbirdNotRunning,
  scanAndParse,
  messageIdSet,
  setsEqual,
  concatRaw,
  planPartition,
  logPlan,
  executePartition,
  checkAndPartition,
};
