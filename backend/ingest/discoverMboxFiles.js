const fs = require('node:fs');
const path = require('node:path');

const SKIP_EXTENSIONS = new Set(['.msf', '.dat', '.html', '.json', '.log']);

function isCandidateMboxFile(entry, dirPath) {
  if (!entry.isFile()) return false;
  if (entry.name.endsWith('.sbd')) return false;
  const ext = path.extname(entry.name).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  const stat = fs.statSync(path.join(dirPath, entry.name));
  return stat.size > 0;
}

// Walks a Thunderbird "Mail/<account>" tree. Each folder is a file with no
// extension; a folder's children (if any) live in a sibling "<name>.sbd"
// directory. Returns an array of absolute mbox file paths.
function discoverMboxFiles(rootDir) {
  const results = [];

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    entries
      .filter((entry) => isCandidateMboxFile(entry, dirPath))
      .forEach((entry) => {
        const filePath = path.join(dirPath, entry.name);
        results.push(filePath);

        const sbdDir = path.join(dirPath, `${entry.name}.sbd`);
        if (fs.existsSync(sbdDir) && fs.statSync(sbdDir).isDirectory()) {
          walk(sbdDir);
        }
      });
  }

  walk(rootDir);
  return results;
}

module.exports = { discoverMboxFiles };
