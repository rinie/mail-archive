# mail-archive

Browse years of archived POP3 mail (living in Thunderbird `mbox` files)
through a fast, custom web frontend — without ever opening Thunderbird for
old mail again.

The `mbox` files stay the source of truth. A [DuckDB](https://duckdb.org/)
database is a queryable, fully rebuildable derived index on top of them.
Message and attachment content is never copied out of the `mbox` files: it's
fetched on demand by seeking directly to a message's recorded byte range and
re-parsing just that one message.

## Why

Thunderbird is a fine mail client but a slow, heavyweight way to search
decades of old mail, and its `mbox` files grow forever as a single
ever-appended file per folder. This project:

- indexes every message's headers/body into DuckDB for instant search and
  filtering by folder, date range, sender, or attachment presence,
- serves that index to a lightweight browser frontend over a WebSocket,
- and, once a live folder (e.g. `Inbox`) grows past a size threshold,
  physically moves old, permanently-closed mail (a full past calendar year)
  out of it into per-year archive files — so the live folder stays small and
  backups of it stay cheap — while **Thunderbird keeps working normally**
  for fetching new mail, and this project's own frontend keeps showing
  `Inbox` as a single logical folder regardless of how many files it's
  physically split across.

See [CONTEXT.md](CONTEXT.md) for the full architecture writeup, the schema,
every design decision and why it was made, and the bugs found and fixed
along the way.

## Architecture

```
mbox files (physical, append-mostly; source of truth)
      |
      | incremental parser (Node.js)
      v
mail.duckdb (queryable index) + per-mbox-file location shards (byte ranges)
      |
      | @duckdb/node-api
      v
Node.js backend (WebSocket, named-query protocol — no raw SQL from client)
      |
      v
Browser frontend (Observable Framework)
```

## Requirements

- Node.js
- A local Thunderbird profile with one or more POP3/local `mbox` folders

## Setup

```bash
npm install
copy backend\config.example.js backend\config.js
```

Edit `backend/config.js` with your real Thunderbird profile directory and
mail account folder (see the comments in `config.example.js` — it's
gitignored since these paths can embed your OS username and mail domain).

## Usage

```bash
npm run ingest
npm run server
```

`npm run ingest` incrementally parses any new mail since the last run (and
partitions a live folder into per-year archives once it crosses the size
threshold — CLI-only, never triggered by the server). `npm run server`
starts the backend the frontend talks to.

```bash
npm run lint
```

## Status

Actively developed against a real, 26-year personal mail archive — not a
generic package meant for arbitrary reuse. Expect to read `CONTEXT.md` and
adjust things to your own Thunderbird setup rather than treating this as a
turnkey tool.

## License

[MIT](LICENSE)
