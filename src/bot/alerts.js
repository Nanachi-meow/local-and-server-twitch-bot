/** Шина алертов для оверлея (/overlay): SSE-подписчики получают всё через push(). */
export const overlay = {
  clients: new Set(),

  push(payload) {
    if (!overlay.clients.size) return;
    const data = JSON.stringify({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...payload });
    for (const res of overlay.clients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        try { overlay.clients.delete(res); } catch {}
      }
    }
  },
};
