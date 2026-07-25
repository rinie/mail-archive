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
  attachments** (822 MB deduped on disk), spanning 2000–2026. 2 messages
  have no parseable `date_utc` (see the date-fallback bug below — one has
  a genuinely ambiguous timezone abbreviation, one is missing a `Date:`
  header entirely).
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
- Message detail pane, date-range filter, and attachments-only toggle:
  wired up and confirmed working. Results and attachments tables are
  bounded to a max-height scrollable container (sticky header) instead of
  growing unbounded. HTML-only messages render inside a sandboxed
  `<iframe sandbox="" srcdoc=...>` — verified directly (real htl, real DOM)
  that a script injected into `srcdoc` cannot execute or touch the parent
  page, which matters given 20+ years of archived mail could contain old
  malicious HTML. Remote images inside that frame are not blocked; doing
  so would need an explicit CSP and wasn't asked for.
- **Silent wrong-date bug, found and fixed**: `mailparser` returns
  `new Date()` (parse time, not message time) for a `Date:` header it
  can't parse, instead of failing — indistinguishable from a real date
  unless you know to look for it. Caught because a 20+-year-old message's
  Date header can never legitimately land within seconds of "whenever
  ingest happened to run." Confirmed against a real header in this
  archive: `"Tue, 10 Jul 2001 16:30:07 C -0500"` — a stray token from a
  broken sender mailer, affecting multiple unrelated senders/gateways in
  this archive identically. `mboxParser.js` now has two narrow,
  independently-verified repairs (the stray-token pattern above, and
  spelled-out US timezone names like "Pacific Daylight Time," which
  resolve DST unambiguously by name); anything else stays `null` rather
  than guessed. Applied retroactively to the already-ingested database via
  a one-off targeted re-parse-and-`UPDATE` (not a full re-ingest) — see
  git history for the fix scripts used, not kept in the repo.

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

## Dynamic mbox partitioning + on-demand retrieval

**Why**: `Inbox` grows forever (631 MB today) because Thunderbird treats it
as one flat, ever-appended file — backing it up efficiently means old,
frozen content has to live in separate files that stop changing, but
Thunderbird must keep using the same profile to fetch new POP3 mail. So old
messages need to be physically moved out of the live `Inbox` mbox, not just
copied elsewhere. Separately, the attachment blob store (below) turned out
to be the wrong call in practice: thousands of tiny content-hash files waste
space via NTFS cluster rounding and are slow to back up regardless of total
bytes (the "node_modules problem").

**Full design**: worked out via a dedicated planning session (including a
Plan-subagent stress-test against the live profile) — see
`C:\Users\Sandra\.claude\plans\curried-greeting-spindle.md` for the complete
plan with all reasoning. Summary of the decisions:

- **Attachment blob store removed.** `attachmentStore.js`/`attachments/`/
  `attachments.blob_path` go away entirely. Attachments stay embedded in the
  mbox exactly as Thunderbird stores them; content is fetched on demand by
  seeking directly into the mbox file and re-parsing just that one message —
  no separate extraction step, no dedup bookkeeping. Trade-off accepted
  explicitly: loses the ~146 MB of dedup savings the blob store had, in
  exchange for deleting an entire subsystem and the small-file problem.
- **New per-mbox-file location shards**: one CSV file per mbox file
  (`message_id, byte_offset, byte_length`), plain uncompressed CSV
  (considered zstd — DuckDB can write it natively, verified working, no new
  dependency — but the shards are only ever a few hundred KB at most, so
  compression buys nothing next to the megabytes of mbox data beside them,
  while plain CSV stays directly `grep`/text-editor inspectable, which
  matters more for byte-offset metadata this safety-critical). This is the
  **authoritative** source for "where do this message's bytes live right
  now" — sharded per mbox file so backup granularity matches the mbox data
  exactly (only the currently-changing file's shard ever needs re-touching).
  `messages.mbox_file` stays in `mail.duckdb` as a read-through cache so the
  frontend keeps querying DuckDB unchanged; `byte_offset` moves out of
  `mail.duckdb` into the shards.
  Shards live in `config.locationsDir` (`backend/locations/`, flat, sanitized
  filenames), a directory **outside** the Thunderbird-managed mbox tree
  entirely, not merely skipped by `discoverMboxFiles.js`'s extension filter —
  confirmed by actually launching real Thunderbird (via computer-use) that it
  treats *any* extra file inside its `Mail/<account>` directory as a
  candidate folder in its own sidebar, regardless of extension. An earlier
  version placed shards as `<mboxfile>.locations.csv` sidecars, which
  cluttered Thunderbird's folder list with 27 fake folders — discovered,
  deleted from the real profile, and moved to the current location before
  any further work.
- **A latent bug found during planning, not introduced by this change**:
  `insertMessage`'s `ON CONFLICT (message_id) DO NOTHING` means a real
  Thunderbird compaction today already silently leaves a stale, wrong
  `byte_offset` in the DB for any message it finds during the
  compaction-fallback full rescan (harmless today since nothing reads
  `byte_offset`; would become actively dangerous — silently serving the
  wrong message's bytes — the moment on-demand retrieval starts relying on
  it). Fix: a single `upsertLocation()` used unconditionally by every full
  rescan (compaction fallback *and* the new partition rewrites), not
  special-cased into the new code alone.
- **A concurrency hazard found during planning**: `server.js` also triggers
  `runIngest()` over the websocket while serving live queries. The new
  partition-trigger check must live only in `runIngest.js`'s
  `require.main === module` block (CLI-invoked `npm run ingest` only),
  never inside the exported `runIngest()` — otherwise a browser-triggered
  refresh could race a partition rewrite against in-flight queries.
- **Partitioning**: triggered when `Inbox` exceeds 300 MB; moves every
  message dated to a fully-closed past calendar year into
  `Inbox.sbd/archive-<year>`, leaving the current year (and any
  unparseable-date message) in place. Heavily guarded: Thunderbird-running
  detection (fail closed on any ambiguity), backup-before-touch, write to
  `.tmp` siblings, independently re-scan and confirm the message-id set
  before ever renaming anything, a rename journal for the
  non-atomic-as-a-pair two-file rename, `.msf` deletion only as the last
  step (Thunderbird's normal, safe index-rebuild path).
- **Logical folder identity** (so this project's own frontend keeps showing
  "Inbox" as one folder regardless of how many physical partition files it's
  split across) is tracked explicitly in a small
  `backend/partition_manifest.csv` (`physical_path, logical_folder`),
  written once per new archive file — not inferred from a filename pattern,
  since that risks misfiring against a genuine Thunderbird folder that
  happens to be named like a year.
- **No new HTTP endpoint, no frontend changes.** The "range request"
  retrieval mechanism is entirely backend-internal; the websocket query
  protocol and its response shapes are unchanged.
- **Migration for the already-ingested 21,387 messages**: given the latent
  bug above, existing `byte_offset` values cannot be trusted blindly — the
  migration re-scans every mbox file fresh and cross-validates against
  what's stored before touching the schema, rather than mechanically
  copying columns. Already run successfully against the live `mail.duckdb`.

### Real bugs this work uncovered in the existing (pre-partitioning) codebase

Three genuine, previously-latent bugs were found and fixed along the way —
none were introduced by partitioning, all were caught by empirically testing
against the real profile/data rather than trusting the design on paper:

1. **Attachment double-insertion**: the old `insertAttachment` had no
   conflict guard, so any message re-encountered during a compaction-fallback
   full rescan got its attachments inserted again. Found via the migration's
   row-count check (6,409 stored vs 6,004 correct); fixed by rebuilding
   `attachments` from scratch and verifying "no message loses all its
   attachments" rather than an exact count match.
2. **Unstable synthetic Message-IDs**: a message with no real `Message-ID`
   header got one synthesized from `<mboxFile:byteOffset>` — stable only as
   long as the message never moves. The first real partition test against a
   full copy of the profile caught this directly: re-parsing a relocated
   message after the move produced a *different* synthetic ID, tripping the
   post-write integrity check. Fixed in `mboxParser.js` by hashing the raw
   message bytes (`sha256(raw)`) instead of embedding position — content is
   stable across any relocation, position isn't. The 4 already-affected rows
   in the live DB were corrected in place (`messages.message_id`,
   `attachments.message_id`, and the location shard renamed via
   `locationIndex.js`'s `renameLocation`), verified by re-resolving each via
   its location shard and confirming the re-parsed content hashes back to
   the same ID.
3. **Stale DuckDB catalog metadata from the migration's temp-table swap**:
   after the migration script's `attachments_new` → `attachments` table
   swap (build into a temp table, verify, then replace), the live
   `mail.duckdb`'s catalog retained an internal reference to the dropped
   `attachments_new` name. `duckdb_constraints()`/`duckdb_dependencies()`
   showed a clean schema (no FK, no lingering table), yet any `UPDATE
   messages SET message_id = ...` failed immediately with `Catalog Error:
   Table with name attachments_new does not exist!`, and a no-op-looking
   update that returned without throwing didn't actually persist. Root
   cause not fully explainable from the visible catalog — treated as a
   known class of DuckDB bug around `CREATE ... AS` / `DROP` / `RENAME`
   sequences leaving stale internal dependency state. Fixed by rebuilding
   the catalog with `EXPORT DATABASE (FORMAT PARQUET)` into a scratch
   directory, `IMPORT DATABASE` into a fresh `.duckdb` file, verifying row
   counts and constraints matched exactly, confirming the failing `UPDATE`
   now worked and persisted, then swapping the rebuilt file into place. The
   pre-rebuild file is kept as `mail.duckdb.pre-catalog-rebuild-backup`.

### Full-copy test against the real profile — passed

Per the user's explicit choice ("full-copy test first" before ever touching
the live `Inbox`): the entire real `Mail/pop.xs4all.nl` directory and
`mail.duckdb` were copied to a scratch location, and the real (non-dry-run)
partition operation was run against the copy end-to-end. Verified:

- Dry-run plan matched the real run's plan exactly (302 retained, 19 new
  `archive-<year>` files spanning 2007–2025, ~4,490 messages relocated).
- Execution completed with no verification-gate failures (this is the exact
  step that previously aborted before the synthetic-ID fix).
- Byte-perfect file accounting: original `Inbox` size (632,365,956 bytes) =
  new `Inbox` size + sum of all 19 archive file sizes, exactly.
- DB row counts after applying `mbox_file` updates: total `messages` count
  unchanged (21,394); per-year grouped counts were a few short of the raw
  scan counts in exactly 4 years, fully explained by 6 genuine duplicate
  Message-IDs physically present in the original `Inbox` (e.g. re-delivered
  notification mail) — the `messages` table has always deduped by
  `message_id` (pre-existing `ON CONFLICT DO NOTHING` behavior), so this is
  expected, not data loss; both physical copies remain in the resulting
  mbox file, only the DB's canonical row collapses to one.
- On-demand retrieval spot-checked against the post-partition layout: 12
  sampled messages across the retained `Inbox` and 3 different
  `archive-<year>` files, including one with 5 attachments, all resolved via
  `messageLocator.js` with correct subjects/attachment counts.

**Still open**: get explicit user confirmation, then run the real
(non-dry-run) partition against the actual live `Inbox` — not yet done.

### Still open

- Search: DuckDB `ILIKE` on `subject`/`body_text` is what's implemented.
  Full-text index only worth adding if it's slow in practice — untested at
  query time on the real 21k-message archive yet (only ingest has been
  exercised at that scale so far).
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
```

`year`/`month` are plain columns, not physical Hive partitions — DuckDB prunes
on them fine at this data volume without needing separate Parquet files. If a
portable export is wanted later, add a one-off `COPY messages TO 'archive/'
(FORMAT PARQUET, PARTITION_BY (year, month))` step — not required for v1.

`byte_offset`/`byte_length` (where a message's bytes currently live) are
**not** in this schema — they live in the per-mbox-file location shards (see
"Dynamic mbox partitioning" above), since a message's physical location
changes on partitioning/compaction while its DuckDB row doesn't need to.
`attachments` has no `blob_path`/foreign key: attachment content is fetched
on demand by re-parsing the parent message's raw bytes
(`messageLocator.js`), and the FK to `messages` was removed because DuckDB
blocks `ALTER TABLE ... DROP COLUMN` on a table with a dependent FK —
`message_id` consistency is maintained by application code, not the
database.

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
`<sha256(raw bytes)@local-synthetic>` id for the rare pre-2000-era message
that lacks one, so the PRIMARY KEY constraint always has something to key
on; content-hashed rather than position-based so the id stays stable if the
message is later physically relocated — see "Dynamic mbox partitioning"
above). Slower, but only triggers when compaction is detected, not on every
run. Location shards are upserted unconditionally on every full rescan
(compaction fallback or partition rewrite), never conditionally on whether
the `INSERT` itself was a no-op — otherwise a relocated message keeps a
stale byte offset forever.

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
      locationIndex.js       # per-mbox-file location shards (source of truth)
      messageLocator.js      # on-demand retrieval by byte range
      partitionMbox.js        # moves closed-year mail out of live Inbox
      runIngest.js            # CLI entry point (ingest, then partition)
  locations/                 # gitignored — location shards (regenerable)
  partition_backups/         # gitignored — pre-partition backups
  partition_runs/            # gitignored — partition rename journals
  frontend/
    (Observable Framework project — not yet initialized)
  eslint.config.js
  mail.duckdb                # gitignored — the database file itself
  backend/partition_manifest.csv  # physical archive file -> logical folder
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
