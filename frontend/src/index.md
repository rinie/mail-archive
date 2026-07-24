# Mail Archive

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
const fromDate = view(Inputs.date({label: "From"}));
```

```js
const toDate = view(Inputs.date({label: "To"}));
```

```js
const attachmentsOnly = view(Inputs.toggle({label: "Attachments only"}));
```

```js
// Inputs.date reports midnight local time; without this, "To: <today>"
// would exclude every message from later that same day.
const toDateEndOfDay = toDate
  ? new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59, 999)
  : null;
```

```js
const messages = await query("messagesByDateRange", {
  folder: folders,
  searchText: searchText || null,
  from: fromDate,
  to: toDateEndOfDay,
  attachmentsOnly,
});
```

```js
// Inputs.table's checkbox-based selection (multiple: false) proved
// unreliable for switching between rows, so selection is driven directly
// by a Mutable set from each row's click handler instead.
const selectedId = Mutable(null);
const setSelectedId = (id) => { selectedId.value = id; };
```

```js
display(
  html`<table class="data-table">
    <thead>
      <tr><th>Date</th><th>From</th><th>Subject</th><th>📎</th></tr>
    </thead>
    <tbody>${messages.map((m) => html.fragment`<tr
        style=${{
          cursor: "pointer",
          background: m.message_id === selectedId ? "var(--theme-foreground-fainter)" : "",
        }}
        onclick=${() => setSelectedId(m.message_id)}
      >
        <td>${m.date_utc ? new Date(m.date_utc).toLocaleString() : ""}</td>
        <td>${m.from_addr || ""}</td>
        <td>${m.subject || ""}</td>
        <td>${m.has_attachments ? "📎" : ""}</td>
      </tr>`)}
    </tbody>
  </table>`,
);
```

Click a row above to load the full message below.

```js
const detail = selectedId ? await query("messageById", {messageId: selectedId}) : null;
```

```js
display(
  detail
    ? html`<div style="border-top: 1px solid var(--theme-foreground-faint); padding-top: 1rem;">
        <h3 style="margin-bottom: 0.25rem;">${detail.subject || "(no subject)"}</h3>
        <p style="color: var(--theme-foreground-muted); margin-top: 0;">
          <strong>From:</strong> ${detail.from_addr || "(unknown)"}<br>
          <strong>To:</strong> ${detail.to_addr || "(unknown)"}<br>
          <strong>Date:</strong> ${detail.date_utc ? new Date(detail.date_utc).toLocaleString() : "(unknown)"}
        </p>
        ${detail.attachments.length
          ? html`<table class="data-table">
              <thead><tr><th>Filename</th><th>Size</th></tr></thead>
              <tbody>${detail.attachments.map((a) => html.fragment`<tr>
                  <td>${a.filename || "(unnamed)"}</td>
                  <td>${Math.round((a.size_bytes || 0) / 1024)} KB</td>
                </tr>`)}
              </tbody>
            </table>`
          : ""}
        <pre style="white-space: pre-wrap; font-family: inherit;">${
          detail.body_text || (detail.body_html ? "(HTML-only message — rendering raw HTML is not supported yet)" : "(no body)")
        }</pre>
      </div>`
    : html`<p><em>No message selected.</em></p>`,
);
```

<style>
.data-table {
  width: 100%;
  border-collapse: collapse;
}
.data-table th {
  text-align: left;
  border-bottom: 1px solid var(--theme-foreground-faint);
  padding: 0.25rem 0.5rem;
}
.data-table td {
  border-bottom: 1px solid var(--theme-foreground-fainter);
  padding: 0.25rem 0.5rem;
}
</style>
