const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Blobs are keyed by content hash so identical attachments (forwarded
// threads, resent files) are stored once, regardless of which message(s)
// reference them.
function writeAttachmentBlob(attachmentsDir, content) {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const subDir = path.join(attachmentsDir, hash.slice(0, 2));
  const blobPath = path.join(subDir, hash);

  if (!fs.existsSync(blobPath)) {
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(blobPath, content);
  }

  return blobPath;
}

module.exports = { writeAttachmentBlob };
