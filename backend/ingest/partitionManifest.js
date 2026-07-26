const fs = require('node:fs');

// backend/partition_manifest.csv: physical_path,logical_folder -- one row
// per physical file *created by* partitionMbox.js, recording which logical
// folder (the live mbox path it was split out of) it belongs to. Used by
// queries.js to fold partition shards back into one logical folder for the
// frontend, and by unpartitionMbox.js to find every physical file that
// needs merging back for a given logical folder. Never written to for
// ordinary, non-partition-created folders -- those simply have no row.

function escapeCsv(value) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Minimal RFC4180 line parser -- same approach as locationIndex.js, kept
// separate since these are two independently-evolvable CSV formats that
// happen to share a parsing technique, not a shared column shape.
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

function appendManifestRow(manifestPath, physicalPath, logicalFolder) {
  const line = `${escapeCsv(physicalPath)},${escapeCsv(logicalFolder)}\n`;
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `physical_path,logical_folder\n${line}`, 'utf8');
  } else {
    fs.appendFileSync(manifestPath, line, 'utf8');
  }
}

// Reads all rows as [{physicalPath, logicalFolder}]. Returns [] if the
// manifest doesn't exist yet (no partition has ever run).
function readManifestRows(manifestPath) {
  if (!fs.existsSync(manifestPath)) return [];
  const lines = fs.readFileSync(manifestPath, 'utf8').split('\n');
  return lines.slice(1).filter(Boolean).map((line) => {
    const [physicalPath, logicalFolder] = parseCsvLine(line);
    return { physicalPath, logicalFolder };
  });
}

// Rewrites the manifest with every row whose physical_path is in
// `physicalPaths` removed -- used by unpartitionMbox.js once those files'
// content has been merged back into their logical folder's live file and
// they cease to exist. A no-op (not even touching the file) if none of the
// given paths currently have a row, so callers can pass a superset freely.
function removeManifestRows(manifestPath, physicalPaths) {
  const toRemove = new Set(physicalPaths);
  const rows = readManifestRows(manifestPath);
  const remaining = rows.filter((row) => !toRemove.has(row.physicalPath));
  if (remaining.length === rows.length) return;

  if (remaining.length === 0) {
    fs.rmSync(manifestPath, { force: true });
    return;
  }
  const lines = remaining.map(
    (row) => `${escapeCsv(row.physicalPath)},${escapeCsv(row.logicalFolder)}`,
  );
  fs.writeFileSync(manifestPath, `physical_path,logical_folder\n${lines.join('\n')}\n`, 'utf8');
}

module.exports = {
  appendManifestRow, readManifestRows, removeManifestRows,
};
