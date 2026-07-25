const { VARCHAR, TIMESTAMP, BOOLEAN } = require('@duckdb/node-api');
const { toTimestampParam } = require('./duckdbClient');

// Named-query map: the only SQL the frontend can trigger. Client sends a
// query name + params over the websocket; the SQL text itself never
// leaves the server (see server.js).

async function messagesByDateRange(connection, params) {
  const reader = await connection.runAndReadAll(
    `SELECT message_id, mbox_file, date_utc, from_addr, to_addr, subject, has_attachments
     FROM messages
     WHERE ($fromDate IS NULL OR date_utc >= $fromDate)
       AND ($toDate IS NULL OR date_utc <= $toDate)
       AND ($folder IS NULL OR mbox_file = $folder)
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
    `SELECT message_id, mbox_file, byte_offset, date_utc, from_addr, to_addr,
            subject, body_text, body_html, has_attachments
     FROM messages
     WHERE message_id = $messageId`,
    { messageId: params.messageId },
    { messageId: VARCHAR },
  );
  const [message] = messageReader.getRowObjectsJS();
  if (!message) return null;

  const attachmentsReader = await connection.runAndReadAll(
    `SELECT filename, content_type, size_bytes, blob_path
     FROM attachments
     WHERE message_id = $messageId`,
    { messageId: params.messageId },
    { messageId: VARCHAR },
  );

  return { ...message, attachments: attachmentsReader.getRowObjectsJS() };
}

async function folderSummary(connection) {
  const reader = await connection.runAndReadAll(
    `SELECT mbox_file, year, month, COUNT(*) AS message_count
     FROM messages
     GROUP BY mbox_file, year, month
     ORDER BY mbox_file, year, month`,
  );
  return reader.getRowObjectsJS();
}

async function attachmentsForMessage(connection, params) {
  const reader = await connection.runAndReadAll(
    `SELECT filename, content_type, size_bytes, blob_path
     FROM attachments
     WHERE message_id = $messageId`,
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
