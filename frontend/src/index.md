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
const messages = await query("messagesByDateRange", {
  folder: folders,
  searchText: searchText || null,
});
```

```js
const selected = view(
  Inputs.table(messages, {
    columns: ["date_utc", "from_addr", "subject", "has_attachments"],
    header: {
      date_utc: "Date",
      from_addr: "From",
      subject: "Subject",
      has_attachments: "📎",
    },
    multiple: false,
    required: false,
  }),
);
```

Select a row above (checkbox on the left) to load the full message below.

```js
const detail = selected ? await query("messageById", {messageId: selected.message_id}) : null;
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
          ? html`<p><strong>Attachments:</strong> ${detail.attachments
              .map((a) => `${a.filename || "(unnamed)"} (${Math.round((a.size_bytes || 0) / 1024)} KB)`)
              .join(", ")}</p>`
          : ""}
        <pre style="white-space: pre-wrap; font-family: inherit;">${
          detail.body_text || (detail.body_html ? "(HTML-only message — rendering raw HTML is not supported yet)" : "(no body)")
        }</pre>
      </div>`
    : html`<p><em>No message selected.</em></p>`,
);
```
