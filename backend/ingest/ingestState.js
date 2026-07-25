const fs = require('node:fs');
const { toTimestampParam } = require('../duckdbClient');

async function getIngestState(connection, mboxPath) {
  const reader = await connection.runAndReadAll(
    'SELECT last_offset, file_size_at_run FROM ingest_state WHERE mbox_path = $mboxPath',
    { mboxPath },
  );
  const [row] = reader.getRowObjectsJS();
  if (!row) return null;
  return { lastOffset: Number(row.last_offset), fileSizeAtRun: Number(row.file_size_at_run) };
}

async function setIngestState(connection, mboxPath, { lastOffset, fileSizeAtRun }) {
  await connection.run(
    `INSERT INTO ingest_state (mbox_path, last_offset, file_size_at_run, last_run_at)
     VALUES ($mboxPath, $lastOffset, $fileSizeAtRun, $lastRunAt)
     ON CONFLICT (mbox_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       file_size_at_run = excluded.file_size_at_run,
       last_run_at = excluded.last_run_at`,
    {
      mboxPath,
      lastOffset,
      fileSizeAtRun,
      lastRunAt: toTimestampParam(new Date()),
    },
  );
}

// Peeks the byte at `offset` to confirm it starts a "From " envelope line,
// as splitMboxMessages would expect for a tail read starting there.
function peekStartsFromLine(mboxPath, offset, currentSize) {
  if (offset >= currentSize) return true; // nothing new to read; trivially fine
  const fd = fs.openSync(mboxPath, 'r');
  try {
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, offset);
    return buf.toString('latin1') === 'From ';
  } finally {
    fs.closeSync(fd);
  }
}

// Decides whether a resumed read from the stored offset is safe, or
// whether the file must be rescanned from 0 (see CONTEXT.md "Compaction
// fallback"). Thunderbird compaction is the only case this guards against;
// a file simply growing since the last run is the common, cheap path.
function needsCompactionFallback(mboxPath, state) {
  if (!state) return false; // first run: full scan from 0 anyway
  const currentSize = fs.statSync(mboxPath).size;
  if (currentSize < state.fileSizeAtRun) return true;
  if (!peekStartsFromLine(mboxPath, state.lastOffset, currentSize)) return true;
  return false;
}

module.exports = { getIngestState, setIngestState, needsCompactionFallback };
