const http = require('node:http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { getConnection } = require('./duckdbClient');
const { queryMap } = require('./queries');
const { runIngest } = require('./ingest/runIngest');

// DuckDB rows can carry BigInt (COUNT(*), BIGINT columns); JSON.stringify
// can't serialize those natively.
function toJson(payload) {
  return JSON.stringify(payload, (key, value) => (
    typeof value === 'bigint' ? Number(value) : value
  ));
}

function send(ws, payload) {
  ws.send(toJson(payload));
}

async function handleMessage(ws, connection, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  // requestId is opaque to the server; echoed back so a client juggling
  // multiple in-flight queries can match responses to requests.
  const { requestId } = parsed;

  if (parsed.type === 'query') {
    const queryFn = queryMap[parsed.name];
    if (!queryFn) {
      send(ws, {
        type: 'error', name: parsed.name, message: `Unknown query: ${parsed.name}`, requestId,
      });
      return;
    }
    try {
      const rows = await queryFn(connection, parsed.params || {});
      send(ws, {
        type: 'result', name: parsed.name, rows, requestId,
      });
    } catch (err) {
      send(ws, {
        type: 'error', name: parsed.name, message: err.message, requestId,
      });
    }
    return;
  }

  if (parsed.type === 'ingest') {
    try {
      await runIngest();
      send(ws, { type: 'ingest_complete', requestId });
    } catch (err) {
      send(ws, {
        type: 'error', name: 'ingest', message: err.message, requestId,
      });
    }
    return;
  }

  send(ws, { type: 'error', message: `Unknown message type: ${parsed.type}`, requestId });
}

async function main() {
  const connection = await getConnection(config.dbPath);

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      handleMessage(ws, connection, raw.toString()).catch((err) => {
        send(ws, { type: 'error', message: err.message });
      });
    });
  });

  httpServer.listen(config.wsPort, () => {
    console.log(`Mail archive backend listening on ws://localhost:${config.wsPort}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
