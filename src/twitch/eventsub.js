import { sleep } from '../store.js';

const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';

/**
 * Клиент EventSub WebSocket (официальный транспорт Twitch).
 * Держит соединение, следит за keepalive, пересоздаёт подписки после обрыва.
 *
 * Один экземпляр = один владелец: ВСЕ подписки сокета создаются токеном
 * из переданного helix. Twitch запрещает смешивать подписки разных
 * пользователей на одном websocket-соединении («websocket transport cannot
 * have subscriptions created by different users»), поэтому подписки бота
 * и стримера живут на ДВУХ отдельных экземплярах (см. index.js:
 * socket — токен бота, broadcasterSocket — токен стримера).
 */
export class EventSocket {
  constructor({ helix, onEvent, onLog }) {
    this.helix = helix; // Helix-клиент, токеном которого создаются все подписки сокета
    this.onEvent = onEvent; // (subscriptionType, event, meta) => void
    this.onLog = onLog; // (message, level) => void
    this.desired = []; // [{key?, type, version, condition}]
    this.sessionId = null;
    this.activeConn = null;
    this.connected = false;
    this.lastEventAt = null;
    this.lastError = null;
    this.subStatus = {}; // type -> 'ok' | 'error: ...'
    this._connSeq = 0;
    this._stopped = true;
    this._backoff = 2000;
    this._watchdog = null;
    this._lastMessageAt = 0;
    this._keepaliveTimeout = 30;
    this._reconnectTimer = null;
  }

  setDesired(list) {
    this.desired = list;
  }

  async start() {
    this._stopped = false;
    this._connect(WS_URL);
  }

  async stop() {
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    clearInterval(this._watchdog);
    for (const conn of this._conns()) {
      try {
        conn.ws.close();
      } catch {}
    }
    this.connected = false;
    this.activeConn = null;
  }

  status() {
    return {
      connected: this.connected,
      sessionId: this.sessionId,
      lastEventAt: this.lastEventAt,
      subStatus: { ...this.subStatus },
      lastError: this.lastError,
    };
  }

  _conns() {
    const out = [];
    for (const conn of this._registry ?? []) out.push(conn);
    return out;
  }

  _connect(url) {
    const conn = { id: ++this._connSeq, url, ws: new WebSocket(url), isPrimary: true };
    (this._registry = this._registry ?? new Set()).add(conn);
    this.activeConn = conn;

    conn.ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      this._onRaw(conn, raw);
    });
    conn.ws.addEventListener('close', (ev) => this._onClose(conn, ev));
    conn.ws.addEventListener('error', () => {
      this.lastError = 'websocket error';
    });
  }

  _onRaw(conn, raw) {
    this._lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const type = msg?.metadata?.message_type;
    if (type === 'session_welcome') {
      this._onWelcome(conn, msg.payload?.session);
    } else if (type === 'notification') {
      this.lastEventAt = Date.now();
      try {
        this.onEvent?.(msg.metadata.subscription_type, msg.payload?.event, msg.metadata);
      } catch (e) {
        this.onLog?.(`Ошибка обработки события ${msg.metadata.subscription_type}: ${e.message}`, 'error');
      }
    } else if (type === 'session_reconnect') {
      this._onReconnect(msg.payload?.session);
    } else if (type === 'revocation') {
      const sub = msg.payload?.subscription;
      const d = this.desired.find((x) => this._fingerprint(x) === this._fingerprint(sub));
      this.onLog?.(`Twitch отозвал подписку ${d?.key ?? sub?.type} (${sub?.status})`, 'warn');
      this.subStatus[(d?.key ?? sub?.type) || '?'] = 'отозвана';
    }
    // session_keepalive — просто отметили активность
  }

  _isPrimary(conn) {
    return conn === this.activeConn;
  }

  async _onWelcome(conn, session) {
    if (!this._isPrimary(conn)) return;
    this.sessionId = session?.id ?? null;
    this._keepaliveTimeout = session?.keepalive_timeout_seconds ?? 30;
    this.connected = true;
    this._backoff = 2000;
    this.lastError = null;
    this.onLog?.(`EventSub подключён (сессия ${this.sessionId})`, 'info');

    try {
      await this._syncSubscriptions();
    } catch (e) {
      this.lastError = e.message;
      this.onLog?.(`Не удалось синхронизировать подписки: ${e.message}`, 'error');
    }

    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      const silent = Date.now() - this._lastMessageAt;
      if (this.connected && silent > (this._keepaliveTimeout + 30) * 1000) {
        this.onLog?.(`Тишина от EventSub ${Math.round(silent / 1000)}с — переподключаюсь`, 'warn');
        this._hardReconnect();
      }
    }, 15_000);
  }

  /** Удаляем осиротевшие подписки прошлых сессий, создаём недостающие для текущей.
   *  Все подписки сокета принадлежат одному владельцу (одному токену) —
   *  токен видит только их список, чужие не трогаем. */
  async _syncSubscriptions() {
    const wanted = new Map();
    for (const d of this.desired) wanted.set(this._fingerprint(d), d);
    let existing = [];
    try {
      existing = await this.helix.listSubscriptions();
    } catch (e) {
      this.onLog?.(`Не удалось получить список подписок: ${e.message}`, 'warn');
    }
    for (const sub of existing) {
      const key = this._fingerprint(sub);
      if (!wanted.has(key)) continue; // чужие подписки не трогаем
      if (sub.transport?.method !== 'websocket') continue;
      if (sub.transport?.session_id === this.sessionId && sub.status === 'enabled') {
        wanted.delete(key); // уже живёт на текущей сессии
      } else {
        try {
          await this.helix.deleteSubscription(sub.id);
        } catch {}
      }
    }
    for (const d of wanted.values()) {
      try {
        await this.helix.createSubscription({
          type: d.type,
          version: d.version,
          condition: d.condition,
          sessionId: this.sessionId,
        });
        this.subStatus[d.key ?? d.type] = 'ok';
      } catch (e) {
        this.subStatus[d.key ?? d.type] = `ошибка: ${e.message}`;
        this.onLog?.(`Подписка не создана [${d.key ?? d.type}]: ${e.message}`, 'error');
      }
    }
    if (this.desired.length && this.desired.length === Object.values(this.subStatus).filter((s) => s === 'ok').length) {
      this.onLog?.(`Все подписки активны (${this.desired.length})`, 'info');
    }
  }

  _fingerprint(item) {
    const condition = { ...(item.condition ?? {}) };
    const sorted = Object.keys(condition)
      .sort()
      .map((k) => [k, condition[k]])
      .flat();
    return `${item.type}|${item.version}|${sorted.join('=')}`;
  }

  _onReconnect(session) {
    const url = session?.reconnect_url;
    if (!url) return;
    this.onLog?.('EventSub просит переподключение на новый сервер', 'info');
    const oldConn = this.activeConn;
    const conn = { id: ++this._connSeq, url, ws: new WebSocket(url), isPrimary: true };
    this._registry.add(conn);
    this.activeConn = conn;
    this._lastMessageAt = Date.now();
    conn.ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      this._onRaw(conn, raw);
    });
    conn.ws.addEventListener('close', (ev) => this._onClose(conn, ev));
    // старое соединение закроем после welcome нового (подписки переносятся автоматически)
    setTimeout(() => {
      try {
        oldConn?.ws?.close();
      } catch {}
    }, 10_000);
  }

  _onClose(conn) {
    this._registry?.delete(conn);
    if (!this._isPrimary(conn)) return; // закрылся старый сокет после миграции — ок
    this.connected = false;
    if (this._stopped) return;
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const delay = this._backoff;
    this._backoff = Math.min(60_000, this._backoff * 2);
    this.onLog?.(`Соединение потеряно — повтор через ${Math.round(delay / 1000)}с`, 'warn');
    this._reconnectTimer = setTimeout(() => {
      if (!this._stopped) this._connect(WS_URL);
    }, delay);
  }

  _hardReconnect() {
    try {
      this.activeConn?.ws?.close();
    } catch {}
  }
}
