// Copy to config.js (gitignored) and fill in real paths. Not committed
// because mbox paths under a Thunderbird profile can embed the account's
// mail domain and the OS username.

const path = require('node:path');

// The Thunderbird profile directory itself -- used to find parent.lock,
// one of the signals partitionMbox.js checks before it will touch a live
// mbox file.
const profileDir = 'C:\\path\\to\\Thunderbird\\Profiles\\<profile>';

// Root of one Thunderbird account's local mail store, e.g.
// Mail/pop.example.com or Mail/Local Folders. Ingestion walks this tree:
// every non-index file is a candidate mbox, and "<name>.sbd" directories
// hold that folder's children (Thunderbird's nested-folder convention).
const mailRootDir = path.join(profileDir, 'Mail', '<pop-account>');

const dbPath = path.join(__dirname, '..', 'mail.duckdb');
const attachmentsDir = path.join(__dirname, '..', 'attachments');
// Deliberately NOT inside mailRootDir: Thunderbird treats any extra file
// in its Mail/<account> tree as a candidate folder in its own UI,
// confirmed by direct observation, regardless of extension.
const locationsDir = path.join(__dirname, '..', 'locations');
const manifestPath = path.join(__dirname, 'partition_manifest.csv');
const partitionBackupDir = path.join(__dirname, '..', 'partition_backups');
const partitionJournalDir = path.join(__dirname, '..', 'partition_runs');

module.exports = {
  profileDir,
  mailRootDir,
  dbPath,
  attachmentsDir,
  locationsDir,
  manifestPath,
  partitionBackupDir,
  partitionJournalDir,
  wsPort: 8787,
};
