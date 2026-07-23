// Copy to config.js (gitignored) and fill in real paths. Not committed
// because mbox paths under a Thunderbird profile can embed the account's
// mail domain and the OS username.

const path = require('node:path');

// Root of one Thunderbird account's local mail store, e.g.
// Mail/pop.example.com or Mail/Local Folders. Ingestion walks this tree:
// every non-index file is a candidate mbox, and "<name>.sbd" directories
// hold that folder's children (Thunderbird's nested-folder convention).
const mailRootDir = 'C:\\path\\to\\Thunderbird\\Profiles\\<profile>\\Mail\\<pop-account>';

const dbPath = path.join(__dirname, '..', 'mail.duckdb');
const attachmentsDir = path.join(__dirname, '..', 'attachments');

module.exports = {
  mailRootDir,
  dbPath,
  attachmentsDir,
  wsPort: 8787,
};
