const { VARCHAR, TIMESTAMP, BOOLEAN } = require('@duckdb/node-api');
const { toTimestampParam } = require('./duckdbClient');
const config = require('./config');

// Named-query map: the only SQL the frontend can trigger. Client sends a
// query name + params over the websocket; the SQL text itself never
// leaves the server (see server.js).

// Maps a physical partition file (e.g. Inbox.sbd/archive-2020) back to its
// logical folder (Inbox) so the frontend never sees the partitioning --
// see partitionMbox.js, which is the only writer of this file. A message
// living in a folder that's never been partitioned has no manifest row,
// so COALESCE below just falls through to the physical mbox_file
// unchanged. The path is escaped for embedding directly in SQL since
// DuckDB's read_csv_auto doesn't take a bound parameter for its filename.
const MANIFEST_PATH = config.manifestPath.replace(/'/g, "''").replace(/\\/g, '/');
const LOGICAL_FOLDER_JOIN = `
  LEFT JOIN read_csv_auto('${MANIFEST_PATH}') AS pm ON messages.mbox_file = pm.physical_path
`;

async function messagesByDateRange(connection, params) {
  const reader = await connection.runAndReadAll(
    `SELECT message_id, COALESCE(pm.logical_folder, mbox_file) AS mbox_file,
            date_utc, from_addr, to_addr, subject, has_attachments
     FROM messages
     ${LOGICAL_FOLDER_JOIN}
     WHERE ($fromDate IS NULL OR date_utc >= $fromDate)
       AND ($toDate IS NULL OR date_utc <= $toDate)
       AND ($folder IS NULL OR COALESCE(pm.logical_folder, mbox_file) = $folder)
       AND ($searchText IS NULL OR subject ILIKE '%' || $searchText || '%'
            OR body_text ILIKE '%' || $searchText || '%')
       AND ($attachmentsOnly = false OR has_attachments = true)
     ORDER BY date_utc DESC
     LIMIT 500`,
    {
      fromDate: toTimestampParam(params.from ? new Date(params.from) : null),
      toDate: toTimestampParam(params.to ? new Date(params.to) : null),
      folder: params.folder || null,
      searchText: params.searchText || null,
      attachmentsOnly: Boolean(params.attachmentsOnly),
    },
    {
      fromDate: TIMESTAMP,
      toDate: TIMESTAMP,
      folder: VARCHAR,
      searchText: VARCHAR,
      attachmentsOnly: BOOLEAN,
    },
  );
  return reader.getRowObjectsJS();
}

async function messageById(connection, params) {
  const messageReader = await connection.runAndReadAll(
    `SELECT message_id, COALESCE(pm.logical_folder, mbox_file) AS mbox_file,
            date_utc, from_addr, to_addr, subject, body_text, body_html, has_attachments
     FROM messages
     ${LOGICAL_FOLDER_JOIN}
     WHERE message_id = $messageId`,
    { messageId: params.messageId },
    { messageId: VARCHAR },
  );
  const [message] = messageReader.getRowObjectsJS();
  if (!message) return null;

  const attachmentsReader = await connection.runAndReadAll(
    `SELECT attachment_index, filename, content_type, size_bytes
     FROM attachments
     WHERE message_id = $messageId
     ORDER BY attachment_index`,
    { messageId: params.messageId },
    { messageId: VARCHAR },
  );

  return { ...message, attachments: attachmentsReader.getRowObjectsJS() };
}

async function folderSummary(connection) {
  const reader = await connection.runAndReadAll(
    `SELECT COALESCE(pm.logical_folder, mbox_file) AS mbox_file, year, month,
            COUNT(*) AS message_count
     FROM messages
     ${LOGICAL_FOLDER_JOIN}
     GROUP BY COALESCE(pm.logical_folder, mbox_file), year, month
     ORDER BY COALESCE(pm.logical_folder, mbox_file), year, month`,
  );
  return reader.getRowObjectsJS();
}

async function attachmentsForMessage(connection, params) {
  const reader = await connection.runAndReadAll(
    `SELECT attachment_index, filename, content_type, size_bytes
     FROM attachments
     WHERE message_id = $messageId
     ORDER BY attachment_index`,
    { messageId: params.messageId },
    { messageId: VARCHAR },
  );
  return reader.getRowObjectsJS();
}

const queryMap = {
  messagesByDateRange,
  messageById,
  folderSummary,
  attachmentsForMessage,
};

module.exports = { queryMap };
