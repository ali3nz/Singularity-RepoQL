// OpenCode activates the same global plugin in multiple locations. The
// persistent plugin storage is shared, so transport ownership must be too.
const key = Symbol.for("openchamber.product.office.transport");
const transport = globalThis[key] ??= { flushing: false };

export async function flushOfficeQueue(storage, endpoint, ingestKey, stopped = () => false, send = fetch) {
  if (transport.flushing || stopped()) return;
  transport.flushing = true;
  try {
    const page = await storage.scan({ prefix: "office/pending/", limit: 50 });
    for (const { key, value } of page.entries) {
      if (stopped()) break;
      const sent = key.replace("/pending/", "/sent/");
      // A delayed event handler may re-add pending after another activation
      // committed its sent marker. Never POST such completed work twice.
      if (await storage.get(sent)) { await storage.remove(key); continue; }
      const response = await send(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": ingestKey },
        body: JSON.stringify(value), signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error(`Office ingest HTTP ${response.status}`);
      await storage.set(sent, true);
      await storage.remove(key);
    }
  } finally { transport.flushing = false; }
}
