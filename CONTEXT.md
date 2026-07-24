# Mail Archive Project — CONTEXT / Handover Plan

## Goal

Browse years of archived POP3 mail (currently living in Thunderbird mbox files)
through a custom frontend, without ever loading Thunderbird again for old mail.
The mbox files stay as the source of truth. A DuckDB database is a queryable,
rebuildable derived index. Ingestion is incremental: only new messages appended
since the last run are parsed, with a safe fallback for the rare case Thunderbird
compacts a file.

## Status

Backend scaffolded and the full real archive has been ingested (2026-07-23):

- `backend/ingest/discoverMboxFiles.js`, `mboxParser.js`, `ingestState.js`,
  `attachmentStore.js`, `runIngest.js` — implemented and working.
- `backend/duckdbClient.js`, `queries.js`, `server.js` — implemented and
  working (verified over a real websocket round trip).
- `eslint.config.js` — flat config wired to `eslint-config-airbnb-extended`;
  `backend/` lints clean.
- `npm run ingest` has been run against the full real archive (27 mbox
  files, all `.sbd` subfolders included): **21,387 messages**, **6,409
  attachments** (822 MB deduped on disk), spanning 2000–2026. Only 1
  message has no parseable `date_utc` out of the whole set.
- Fixed during that first full run: `mailparser`'s `from`/`to` fields come
  back as an *array* of AddressObjects (not a single one) when a header
  repeats — real in mail this old — and DuckDB's VARCHAR binder throws on
  `undefined` (only accepts `string`/`null`). Fixed in `mboxParser.js`
  (`addressText()` helper) plus a defensive `orNull()` normalization in
  `runIngest.js`'s `insertMessage` so the next unforeseen field shape fails
  soft instead of crashing the run. The crash-safety of the incremental
  design held up as intended: the run resumed cleanly from the last
  fully-committed file, no data loss or duplication.
- Frontend (`frontend/src/index.md`) verified working in a real browser
  against the full real archive: folder select, search box, and results
  table all render and query correctly. One bug fixed to get there: an
  explicit `import {Inputs} from "npm:@observablehq/inputs"` shadowed
  Framework's automatically-injected `Inputs` global with something that
  resolved to `undefined`, breaking every `Inputs.*` call. Framework
  provides `Inputs` (and `d3`, `Plot`, etc.) to every cell without an
  import — removed the import rather than fixing it. (Note: this session's
  own sandboxed Browser pane tool can't composite frames, so Framework's
  `requestAnimationFrame`-driven runtime never ticks there regardless of
  page content — that's a tooling limitation of this session, unrelated to
  the bug above, and doesn't affect a normal browser.)

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
  Full-text index only worth adding if it's slow in practice — untested at
  query time on the real 21k-message archive yet (only ingest has been
  exercised at that scale so far).
- Message detail pane, date-range filter, and attachments-only toggle are
  all wired up and confirmed working (see "Frontend" below). All items
  from the original plan's frontend checklist are now done except the
  optional ingest-notification reuse, which was explicitly "skip unless
  useful."
- `Mutable()` doesn't behave in Framework `.md` pages the way it does in
  hand-authored Observable notebooks: notebooks' compiler special-cases
  `name = Mutable(...)` cells to shadow the raw wrapper for `.value`
  writes elsewhere; Framework's markdown compiler has no such handling
  (confirmed by grepping its compiler source — only the client runtime
  references `Mutable`). Its `Mutable()` is a genuine `async function*`
  under the hood, so Observable Runtime's `generatorish()` duck-typing
  auto-unwraps any cell exporting one into its live current value. Rule of
  thumb for this codebase: use `x.value = ...` only inside the cell that
  defines `const x = Mutable(...)`; every other cell reads the live value
  as the bare name `x`, never `x.value`.

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

`frontend/src/index.md` implements and has verified working (real browser,
full archive) everything from the original plan except the optional
ingest-notification item: a WebSocket connection opened on load, a folder
select, a free-text search box, From/To date filters, an attachments-only
toggle, a results table, and a message detail pane (click a row → full
body + an attachments table via `messageById`).

The results table and the detail pane's attachment list are hand-built
HTML tables (`html` template literals), not `Inputs.table` — its
checkbox-based single-selection didn't reliably update across row
switches, so selection state is a `Mutable` set directly from each row's
click handler instead (see the `Mutable` gotcha noted above).

Not done, low priority: reusing the manifest-poll instinct from the Oracle
project for "new mail ingested" notifications — was explicitly "skip
unless useful," and the websocket already supports pushing an
`ingest_complete` event instead of polling if this is ever wanted.

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
