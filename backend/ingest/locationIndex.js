const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

// Per-mbox-file sidecar recording "where do this file's messages live right
// now" -- message_id, byte_offset, byte_length, following splitMboxMessages'
// exact convention (offset = start of the "From " envelope line, length =
// bytes through the next message's "From " line or EOF, i.e. exactly the
// `raw` slice parseMboxMessage expects). This is the authoritative source
// for message locations; mail.duckdb's messages.mbox_file is a read-through
// cache kept in sync separately.
//
// Plain, uncompressed CSV, read/written directly rather than through
// DuckDB: these shards are only ever a few hundred KB at most (a few
// thousand rows of message_id + two integers), so a full read-modify-write
// per update is cheap, and skipping DuckDB here keeps this safety-critical
// metadata readable with a text editor with zero tooling.
//
// Shards live in config.locationsDir, a flat directory OUTSIDE the
// Thunderbird-managed mbox tree entirely -- not merely skipped by
// discoverMboxFiles.js's extension filter. Confirmed by direct observation
// (launching real Thunderbird) that it treats any extra file inside its
// Mail/<account> directory as a candidate folder in its own UI regardless
// of extension, so sitting a sidecar next to the mbox file it describes
// would clutter Thunderbird's own folder list with junk entries. The
// absolute mbox path is sanitized into one flat filename (not mirrored
// subdirectories) so this works for any mbox path, including ones outside
// config.mailRootDir (e.g. a test profile).
function shardPathFor(mboxFile) {
  const sanitized = path.resolve(mboxFile).replace(/[:\\/]/g, '_');
  return path.join(config.locationsDir, `${sanitized}.csv`);
}

function csvField(value) {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Minimal RFC4180 line parser -- sufficient for exactly 3 known columns,
// the last two of which are always plain integers.
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// Reads a locations CSV at an exact file path into a
// Map<messageId, {byteOffset, byteLength}>. Returns an empty Map if the
// file doesn't exist.
function parseLocationsFile(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  lines.slice(1).filter(Boolean).forEach((line) => {
    const [messageId, byteOffset, byteLength] = parseCsvLine(line);
    map.set(messageId, { byteOffset: Number(byteOffset), byteLength: Number(byteLength) });
  });
  return map;
}

// Reads a mbox file's location shard (by mbox file path, not shard path).
function readLocations(mboxFile) {
  return parseLocationsFile(shardPathFor(mboxFile));
}

// Atomically replaces a mbox file's location shard with the exact
// contents of `map`, verifying the write round-trips before swapping it
// in -- this metadata is load-bearing for byte-exact retrieval.
function writeLocations(mboxFile, map) {
  const lines = ['message_id,byte_offset,byte_length'];
  Array.from(map.entries()).forEach(([messageId, loc]) => {
    lines.push(`${csvField(messageId)},${loc.byteOffset},${loc.byteLength}`);
  });
  const content = `${lines.join('\n')}\n`;

  const shardPath = shardPathFor(mboxFile);
  fs.mkdirSync(path.dirname(shardPath), { recursive: true });
  const tmpPath = `${shardPath}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');

  const verified = parseLocationsFile(tmpPath);
  if (verified.size !== map.size) {
    throw new Error(
      `Location shard write for ${mboxFile} did not round-trip: `
      + `expected ${map.size} rows, got ${verified.size}`,
    );
  }

  fs.renameSync(tmpPath, shardPath);
}

// Merges `entries` (array of {messageId, byteOffset, byteLength}) into the
// mbox file's location shard, overwriting any existing entry for the same
// messageId. This must be called unconditionally for every message found
// during any full rescan of a file (compaction fallback or a partition
// rewrite) as well as ordinary incremental ingest -- never conditionally,
// or a message that physically moved keeps a stale location forever (see
// CONTEXT.md).
function upsertLocations(mboxFile, entries) {
  const existing = readLocations(mboxFile);
  entries.forEach((entry) => {
    existing.set(entry.messageId, { byteOffset: entry.byteOffset, byteLength: entry.byteLength });
  });
  writeLocations(mboxFile, existing);
}

// Renames a location entry from oldMessageId to newMessageId, keeping the
// same byte range -- for when a message's *identity* changes (e.g.
// correcting a synthetic id, see mboxParser.js) rather than its location.
// A no-op if oldMessageId has no entry.
function renameLocation(mboxFile, oldMessageId, newMessageId) {
  const existing = readLocations(mboxFile);
  const location = existing.get(oldMessageId);
  if (!location) return;
  existing.delete(oldMessageId);
  existing.set(newMessageId, location);
  writeLocations(mboxFile, existing);
}

// Looks up a single message's location. Used by on-demand retrieval.
function getLocation(mboxFile, messageId) {
  return readLocations(mboxFile).get(messageId) || null;
}

// Deletes a mbox file's location shard entirely -- for when the mbox file
// itself stops existing (e.g. unpartitionMbox.js merging an archive file's
// content into another file and removing the now-empty original).
function deleteShard(mboxFile) {
  const shardPath = shardPathFor(mboxFile);
  fs.rmSync(shardPath, { force: true });
}

module.exports = {
  shardPathFor, readLocations, upsertLocations, renameLocation, getLocation, deleteShard,
};
