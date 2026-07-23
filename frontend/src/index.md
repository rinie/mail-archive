# Mail Archive

```js
import {Inputs} from "npm:@observablehq/inputs";
```

```js
const ws = new WebSocket("ws://localhost:8787");

function query(name, params = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.requestId !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.type === "error") reject(new Error(msg.message));
      else resolve(msg.rows);
    };
    ws.addEventListener("message", onMessage);
    const send = () => ws.send(JSON.stringify({type: "query", name, params, requestId: id}));
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.addEventListener("open", send, {once: true});
  });
}
```

```js
const folders = view(
  Inputs.select(
    [null, ...new Set((await query("folderSummary")).map((r) => r.mbox_file))],
    {label: "Folder", format: (f) => (f === null ? "All folders" : f.split(/[\\/]/).pop())},
  ),
);
```

```js
const searchText = view(Inputs.text({label: "Search", placeholder: "subject or body contains…"}));
```

```js
const messages = await query("messagesByDateRange", {
  folder: folders,
  searchText: searchText || null,
});
```

```js
display(
  Inputs.table(messages, {
    columns: ["date_utc", "from_addr", "subject", "has_attachments"],
    header: {
      date_utc: "Date",
      from_addr: "From",
      subject: "Subject",
      has_attachments: "📎",
    },
  }),
);
```

Click a row's message ID below to load the full message (detail pane wiring
is a next step — for now this confirms the query round-trip end to end).
