# Mail Archive Project — CONTEXT / Handover Plan

## Goal

Browse years of archived POP3 mail (currently living in Thunderbird mbox files)
through a custom frontend, without ever loading Thunderbird again for old mail.
The mbox files stay as the source of truth. A DuckDB database is a queryable,
rebuildable derived index. Ingestion is incremental: only new messages appended
since the last run are parsed, with a safe fallback for the rare case Thunderbird
compacts a file.

## Status

Backend scaffolded and smoke-tested against real mbox data (2026-07-23):

- `backend/ingest/discoverMboxFiles.js`, `mboxParser.js`, `ingestState.js`,
  `attachmentStore.js`, `runIngest.js` — implemented and working.
- `backend/duckdbClient.js`, `queries.js`, `server.js` — implemented and
  working (verified over a real websocket round trip).
- `eslint.config.js` — flat config wired to `eslint-config-airbnb-extended`;
  `backend/` lints clean.
- Not yet done: frontend (Observable Framework project not yet initialized —
  see `frontend/`), and no full ingestion run against the real archive has
  been performed yet (only a 2-file subset, to avoid a long first run and
  large disk use without the user driving that step explicitly).

### Resolved open decisions (were flagged for Claude Code, now checked)

- **Mbox source paths**: confirmed via the actual Thunderbird profile on
  this machine. The POP3 account is `pop.xs4all.nl`, profile
  `y8cfewr6.slt`, root:
  `%APPDATA%\Thunderbird\Profiles\y8cfewr6.slt\Mail\pop.xs4all.nl`.
  This is a nested folder tree (Thunderbird's `<name>.sbd` convention for
  subfolders — e.g. `AA.sbd/Sioen`, `Privé.sbd/Bruiloft`), not a flat list,
  so `discoverMboxFiles.js` walks it recursively rather than hardcoding
  file names. The old `ImapMail/imap.googlemail.com` account under the same
  profile is empty/unused and is not part of this project's scope.
- **Config vs. secrets**: the real mbox root path embeds the ISP domain and
  the OS username, so it lives in `backend/config.js` (gitignored), not in
  the repo. `backend/config.example.js` is the committed template.

### Still open

- Attachment blob dedup by content hash is implemented
  (`backend/ingest/attachmentStore.js`, SHA-256, sharded by first 2 hex
  chars) — not revisited since it's cheap and matches the plan; no need to
  reopen unless it becomes a problem.
- Search: DuckDB `ILIKE` on `subject`/`body_text` is what's implemented.
  Full-text index only worth adding if it's slow in practice on the real
  ~1.3 GB archive — untested at that scale yet.
- The full real archive has *not* been ingested yet. Some folders are large
  (`Inbox` 631 MB, `AA` 182 MB, `Scholtens` 150 MB, `Casa` 117 MB,
  `Proposals` 113 MB, `Hamlet` 103 MB) — first run will take a while and
  will write many attachment blobs to disk. Run `npm run ingest` when ready
  for that.

## Architecture (Gutenberg/Semantic split)

```
mbox files (Gutenberg: physical, append-mostly)
      |
      | incremental parser (Node.js)
      v
DuckDB file: mail.duckdb (Semantic: queryable index)
      |
      | @duckdb/node-api (Neo client) — NOT the legacy duckdb node bindings
      v
Node.js backend process (Express or plain http, ws for the socket)
      |
      | WebSocket, named-query protocol (no raw SQL from client)
      v
Observable Framework page (Observable Inputs / Forms for filters)
      browser — talks to the backend over ws://localhost:<port>
```

No DuckDB-WASM here — this is local, single-user, native DuckDB, same reasoning
as the earlier "socket instead of WASM" decision: full extension support, all
cores/memory, no need to ship data into the browser.

## DuckDB schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  message_id   VARCHAR PRIMARY KEY,
  mbox_file    VARCHAR NOT NULL,
  byte_offset  BIGINT NOT NULL,
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

CREATE TABLE IF NOT EXISTS attachments (
  message_id   VARCHAR NOT NULL REFERENCES messages(message_id),
  filename     VARCHAR,
  content_type VARCHAR,
  size_bytes   BIGINT,
  blob_path    VARCHAR
);

CREATE TABLE IF NOT EXISTS ingest_state (
  mbox_path         VARCHAR PRIMARY KEY,
  last_offset        BIGINT NOT NULL,
  file_size_at_run   BIGINT NOT NULL,
  last_run_at        TIMESTAMP NOT NULL
);
```

`year`/`month` are plain columns, not physical Hive partitions — DuckDB prunes
on them fine at this data volume without needing separate Parquet files. If a
portable export is wanted later, add a one-off `COPY messages TO 'archive/'
(FORMAT PARQUET, PARTITION_BY (year, month))` step — not required for v1.

Attachment blobs live on disk (`blob_path`), keyed by content hash, not inline
in DuckDB — keeps the DB small and query-fast.

## Incremental ingestion algorithm

For each configured mbox file:

1. Read `ingest_state` row for this path (if none, treat as first full run,
   `last_offset = 0`).
2. Stat the file. If `current_size < file_size_at_run` → file was compacted or
   replaced. Go to **compaction fallback**.
3. Otherwise, peek the bytes at `last_offset` — confirm they start a `From `
   envelope line. If not → compaction happened without shrinking below the old
   size (rare but possible). Go to **compaction fallback**.
4. Read from `last_offset` to EOF, split on `^From ` boundaries (careful:
   body lines are `>From `-escaped by mbox convention — do not naive-split),
   parse each new message.
5. For each parsed message: `INSERT ... ON CONFLICT (message_id) DO NOTHING`
   (defends against any edge-case double-processing).
6. Update `ingest_state` with new `last_offset` (= new EOF) and
   `file_size_at_run`.

**Compaction fallback:** full scan of the mbox from offset 0, parse every
message, `INSERT ... ON CONFLICT (message_id) DO NOTHING` against the existing
table (Message-ID is the natural dedup key — falls back to a synthetic
`<mboxFile:offset@local-synthetic>` id for the rare pre-2000-era message that
lacks one, so the PRIMARY KEY constraint always has something to key on).
Slower, but only triggers when compaction is detected, not on every run.

Message boundary splitting and RFC822/MIME parsing are deliberately split:
`backend/ingest/mboxParser.js` hand-rolls only the bespoke part (byte-exact
`From `-line boundaries + mboxrd `>From ` unescaping, both needed for the
offset math above); actual header/MIME/attachment parsing is delegated to
`mailparser` rather than hand-rolled, since charset/encoding/multipart
handling is a solved problem where a hand-rolled version risks silent data
corruption on old mail.

## Backend

- Node.js, `@duckdb/node-api` (the Neo client) — do not use the older
  `duckdb` npm package's callback-style API.
- One persistent DuckDB connection, opened against `mail.duckdb` on startup.
- No raw SQL accepted from the frontend. Instead, a small named-query map —
  same pattern as the existing `routeMap.js` / `procedureMap.js` split from
  the Oracle middleware project: query *names* and *params* come over the
  wire, the actual SQL text lives server-side only.

Named queries implemented in `backend/queries.js`:
  - `messagesByDateRange(from, to, folder?, searchText?)`
  - `messageById(messageId)` — full body + attachment list
  - `folderSummary()` — counts per year/month for the sidebar
  - `attachmentsForMessage(messageId)`

- WebSocket layer (`ws` package): client sends
  `{ type: 'query', name: 'messagesByDateRange', params: {...} }`, server
  replies `{ type: 'result', name, rows }` or `{ type: 'error', message }`.
  A `{ type: 'ingest' }` message triggers `runIngest()` and replies
  `{ type: 'ingest_complete' }`.
- DuckDB rows can carry `BigInt` (e.g. `COUNT(*)`); the server's JSON
  serialization has a replacer that downcasts `bigint` to `number` — plain
  `JSON.stringify` throws on `BigInt` otherwise.

## Frontend

Not yet started. Plan (unchanged from original):

- Observable Framework page(s), static-built as usual, but instead of
  fetching static Parquet from `dist/data/`, the page opens a WebSocket to
  the backend on load.
- Observable Inputs / Forms for the filter controls: date range, folder
  select, free-text search box, attachment-only toggle.
- Results table + a message detail pane (click a row → fetch full body via
  `messageById`).
- Reuse the existing manifest-poll instinct from the Oracle project only if
  useful for "new mail ingested" notifications — otherwise skip it, since the
  websocket is already live and can push an `ingest_complete` event instead of
  polling.

## Conventions to follow (standing preferences)

- Node.js throughout, no Python.
- File extensions always `.js`, never `.mjs`/`.cjs`.
- Semicolons always, single quotes, no inline exports — collect exports at
  bottom of file.
- `eslint-config-airbnb-extended` as the ESLint config.
- No positional `ORDER BY` in any generated SQL — always named columns.
- `cmd`, not PowerShell/bash, for any Windows-side commands in scripts/docs.

## File layout

```
mail-archive/
  backend/
    server.js              # ws + http bootstrap
    duckdbClient.js         # Neo client connection, schema init
    queries.js              # named-query map (routeMap-equivalent)
    config.js               # gitignored — real local mbox/db paths
    config.example.js       # committed template
    ingest/
      discoverMboxFiles.js  # walks Mail/<account> incl. *.sbd subfolders
      mboxParser.js          # From-line splitting, header/body parsing
      ingestState.js         # offset read/write, compaction detection
      attachmentStore.js     # content-hash blob storage
      runIngest.js            # CLI entry point
  frontend/
    (Observable Framework project — not yet initialized)
  eslint.config.js
  mail.duckdb                # gitignored — the database file itself
  CONTEXT.md                 # this file, kept updated as the handover doc
```

## Running it

```bash
npm install
npm run ingest
npm run server
npm run lint
```

`backend/config.js` must exist first — copy `backend/config.example.js` and
fill in the real `mailRootDir` (see "Resolved open decisions" above for this
machine's actual path).
