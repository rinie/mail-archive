const { DuckDBInstance, timestampValue } = require('@duckdb/node-api');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  message_id   VARCHAR PRIMARY KEY,
  mbox_file    VARCHAR NOT NULL,
  date_utc     TIMESTAMP,
  year         SMALLINT,
  month        TINYINT,
  from_addr    VARCHAR,
  to_addr      VARCHAR,
  subject      VARCHAR,
  body_text    VARCHAR,
  body_html    VARCHAR,
  has_attachments BOOLEAN DEFAULT false
);

-- No REFERENCES messages(message_id): DuckDB blocks ALTER TABLE ... DROP
-- COLUMN on a table with dependent foreign keys, which would otherwise
-- block future schema changes (this migration's own messages.byte_offset
-- drop hit exactly that). message_id consistency is maintained by the
-- application code (insertMessage/insertAttachment always agree), not the
-- database.
CREATE TABLE IF NOT EXISTS attachments (
  message_id       VARCHAR NOT NULL,
  attachment_index SMALLINT NOT NULL,
  filename         VARCHAR,
  content_type     VARCHAR,
  size_bytes       BIGINT
);

CREATE TABLE IF NOT EXISTS ingest_state (
  mbox_path         VARCHAR PRIMARY KEY,
  last_offset        BIGINT NOT NULL,
  file_size_at_run   BIGINT NOT NULL,
  last_run_at        TIMESTAMP NOT NULL
);
`;

// Converts a JS Date to the bigint-microseconds form the DuckDB TIMESTAMP
// binder expects (params.dateUtc may legitimately be null for mail with no
// parseable Date header).
function toTimestampParam(date) {
  return date ? timestampValue(BigInt(date.getTime()) * 1000n) : null;
}

let connectionPromise = null;

async function getConnection(dbPath) {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const instance = await DuckDBInstance.create(dbPath);
      const connection = await instance.connect();
      await connection.run(SCHEMA_SQL);
      return connection;
    })();
  }
  return connectionPromise;
}

module.exports = { getConnection, toTimestampParam };
