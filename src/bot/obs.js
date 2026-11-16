import { createHash } from 'node:crypto';

/** Версия протокола obs-websocket 5, которую мы говорим (rpcVersion 1 — базовая, OBS 30.x+). */
export const OBS_RPC_VERSION = 1;

/** Дефолты секции settings.obs (зеркалятся в loadSettings движка команд). */
export const OBS_SETTINGS_DEFAULTS = { enabled: false, host: '127.0.0.1', port: 4455, password: '' };

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const KEEPALIVE_INTERVAL_MS = 25_000;

// ---------------- чистые функции протокола (тестируются без сети) ----------------

/** base64( sha256( utf8(text) ) ). */
export function sha256Base64(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('base64');
}

/**
 * Строка авторизации Identify по формуле obs-websocket 5:
 * base64(sha256( base64(sha256(password+salt)) + challenge )).
 */
export function buildIdentifyAuth(password, salt, challenge) {
  const secret = sha256Base64(`${String(password ?? '')}${String(salt ?? '')}`);
  return sha256Base64(`${secret}${String(challenge ?? '')}`);
}

/**
 * Identify-сообщение: rpcVersion 1, eventSubscriptions 0 (события нам не нужны).
 * authentication добавляется только если сервер прислал challenge И у нас есть пароль.
 */
export function buildIdentify({ password = '', authentication = null, rpcVersion = OBS_RPC_VERSION, eventSubscriptions = 0 } = {}) {
  const d = { rpcVersion };
  if (authentication?.challenge && authentication?.salt && String(password ?? '')) {
    d.authentication = buildIdentifyAuth(password, authentication.salt, authentication.challenge);
  }
  d.eventSubscriptions = eventSubscriptions;
  return { op: 'Identify', d };
}

/** Разбор входящего сообщения. Не-JSON / не объект / без op → null. */
export function parseMessage(raw) {
  try {
    const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    return (msg && typeof msg === 'object' && typeof msg.op === 'string') ? msg : null;
  } catch {
    return null;
  }
}

/** Разбор RequestResponse → { id, type, ok, code, comment, data }. Чужой op → null. */
export function parseRequestResponse(msg) {
  if (!msg || msg.op !== 'RequestResponse' || !msg.d) return null;
  const d = msg.d;
  return {
    id: String(d.requestId ?? ''),
    type: String(d.requestType ?? ''),
    ok: Boolean(d.requestStatus?.result),
    code: String(d.requestStatus?.code ?? ''),
    comment: String(d.requestStatus?.comment ?? ''),
    data: d.responseData ?? null,
  };
}

let requestSeq = 0;

/** Уникальный id запроса (ответ сопоставляется по нему). */
export function nextRequestId() {
  requestSeq += 1;
  return `obs-${Date.now().toString(36)}-${requestSeq}`;
}

/** Request-frame протокола: op Request + requestType/requestId/requestData. */
export function buildRequest(requestType, requestData = undefined, requestId = nextRequestId()) {
  const d = { requestType, requestId };
  if (requestData !== undefined) d.requestData = requestData;
  return { op: 'Request', d };
}

/** Задержка переподключения: 5с · 10с · 20с · 40с · 60с (потом по 60с). */
export function reconnectDelay(attempt) {
  const a = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** a));
}

// ---------------- клиент ----------------

/**
 * Клиент obs-websocket 5 на встроенном WebSocket Node 22 (без зависимостей).
 * Хост/порт/пароль — из живого settings.obs (панель правит на ходу через reconfigure()).
 */
export class ObsClient {
  constructor({ logs, settings, WebSocketCtor = globalThis.WebSocket, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.logs = logs;
    this.settings = settings;
    this.WebSocketCtor = WebSocketCtor;
    this.requestTimeoutMs = requestTimeoutMs;
    this._ws = null;
    this._pending = new Map();   // requestId → { resolve, reject, timer }
    this._waiters = new Set();   // ждущие установки соединения
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._shouldRun = false;
    this._attempt = 0;
    this._cfgSig = '';
    this.status = 'off'; // off | connecting | identified? нет: connecting | connected | reconnecting
  }

  get cfg() {
    return { ...OBS_SETTINGS_DEFAULTS, ...(this.settings?.obs ?? {}) };
  }

  log(message, level = 'info') {
    this.logs?.system?.push?.({ level, message });
  }

  _url() {
    const c = this.cfg;
    return `ws://${String(c.host || '127.0.0.1')}:${Number(c.port) || 4455}`;
  }

  _sig() {
    const c = this.cfg;
    return `${c.host}:${c.port}:${c.password}`; // только в памяти, не пишется в логи
  }

  /** Запуск: включён в настройках → подключаемся (автопереподключение уже работает). */
  start() {
    if (this._shouldRun) return;
    this._cfgSig = this._sig();
    this._shouldRun = true;
    this._attempt = 0;
    this._connect();
  }

  stop() {
    this._shouldRun = false;
    this._clearReconnect();
    this._stopKeepalive();
    this._rejectWaiters(new Error('Клиент OBS остановлен'));
    this._failAllPending('Клиент OBS остановлен');
    this._closeWs(1000, 'stop');
    this.status = 'off';
  }

  /** Настройки изменились в панели: вкл → коннект, выкл → дисконнект, другие host/port/пароль → реконнект. */
  reconfigure() {
    const c = this.cfg;
    if (!c.enabled) {
      if (this._shouldRun) this.log('OBS-интеграция выключена — отключаюсь', 'info');
      this.stop();
      return;
    }
    if (!this._shouldRun) {
      this.log(`OBS-интеграция включена: ${String(c.host)}:${Number(c.port) || 4455}`, 'info');
      this.start();
      return;
    }
    const sig = this._sig();
    if (sig !== this._cfgSig) {
      this._cfgSig = sig;
      this._attempt = 0;
      this.log('Настройки OBS изменились — переподключаюсь', 'info');
      this._closeWs(1000, 'reconfigure'); // закрытие само запланирует реконнект
    }
  }

  // ---------------- соединение ----------------

  _connect() {
    if (!this._shouldRun) return;
    if (typeof this.WebSocketCtor !== 'function') {
      this.log('В этом Node нет встроенного WebSocket — OBS-интеграция недоступна', 'error');
      this._shouldRun = false;
      return;
    }
    const url = this._url();
    this.status = 'connecting';
    this.log(`Подключаюсь к OBS: ${url}`, 'info');
    try {
      const ws = new this.WebSocketCtor(url);
      this._ws = ws;
      ws.addEventListener('message', (ev) => this._onRaw(ev.data));
      ws.addEventListener('close', (ev) => this._onClose(ev?.code, ev?.reason));
      ws.addEventListener('error', () => { /* close приедет следом — реконнект там */ });
    } catch {
      this._ws = null;
      this._scheduleReconnect();
    }
  }

  _onRaw(data) {
    const msg = parseMessage(data);
    if (!msg) return;
    switch (msg.op) {
      case 'Hello': {
        const identify = buildIdentify({ password: this.cfg.password ?? '', authentication: msg.d?.authentication ?? null });
        this.status = 'identifying';
        this._send(identify);
        break;
      }
      case 'Identified': {
        this.status = 'connected';
        this._attempt = 0;
        this.log('OBS подключён (obs-websocket 5) ✅', 'info');
        this._resolveWaiters();
        this._startKeepalive();
        break;
      }
      case 'RequestResponse': {
        const r = parseRequestResponse(msg);
        if (!r) return;
        const p = this._pending.get(r.id);
        if (!p) return;
        this._pending.delete(r.id);
        clearTimeout(p.timer);
        if (r.ok) p.resolve(r.data);
        else p.reject(new Error(`${r.type}: ${r.comment || r.code || 'ошибка OBS'}`));
        break;
      }
      default:
        break; // eventSubscriptions: 0 — событий не приходит
    }
  }

  _onClose(code, reason) {
    const hadConnection = this.status === 'connected';
    this._stopKeepalive();
    this._failAllPending('соединение с OBS закрыто');
    const why = reason ? `: ${reason}` : '';
    this._rejectWaiters(new Error(`Нет соединения с OBS${code ? ` (код ${code})` : ''}${why}`));
    this._ws = null;
    this.status = this._shouldRun ? 'reconnecting' : 'off';
    if (this._shouldRun) {
      if (hadConnection || this._attempt === 0) this.log(`OBS отключился${why} — переподключусь через ${Math.round(reconnectDelay(this._attempt) / 1000)} с`, 'warn');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = reconnectDelay(this._attempt);
    this._attempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _closeWs(code, reason) {
    const ws = this._ws;
    if (!ws) return;
    this._ws = null;
    try { ws.close(code, reason); } catch {}
    this._onClose(code, reason); // таймеров реконнекта нет — _shouldRun проверит сам
  }

  _send(obj) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) throw new Error('OBS не подключён');
    ws.send(JSON.stringify(obj));
  }

  // ---------------- ждущие соединения ----------------

  _waitConnected(timeoutMs = 8_000) {
    if (this.status === 'connected') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const timer = setTimeout(() => {
        this._waiters.delete(entry);
        reject(new Error('OBS не ответил за разумное время — проверь, что OBS запущен, а WebSocket-сервер включён (Инструменты → Настройки WebSocket-сервера)'));
      }, Math.max(1_000, Number(timeoutMs) || 8_000));
      entry.resolve = () => { clearTimeout(timer); resolve(); };
      entry.reject = (e) => { clearTimeout(timer); reject(e); };
      this._waiters.add(entry);
    });
  }

  _resolveWaiters() {
    for (const w of this._waiters) w.resolve();
    this._waiters.clear();
  }

  _rejectWaiters(e) {
    for (const w of this._waiters) w.reject(e);
    this._waiters.clear();
  }

  _failAllPending(why) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      this._pending.delete(id);
    }
  }

  // ---------------- keepalive (пинг протокола) ----------------

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (this.status !== 'connected') return;
      this._request('GetVersion', undefined, 15_000)
        .catch(() => {
          if (this.status !== 'connected') return; // уже разрулили (ответ-таймаут, реконнект)
          this.log('OBS не отвечает на пинг — переподключаюсь', 'warn');
          this._closeWs(4000, 'keepalive');
        });
    }, KEEPALIVE_INTERVAL_MS);
    this._keepaliveTimer.unref?.();
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  // ---------------- запросы ----------------

  /** Отправить запрос и дождаться RequestResponse (таймаут — защита от зависшего OBS). */
  _request(requestType, requestData = undefined, timeoutMs = this.requestTimeoutMs) {
    const id = nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${requestType}: OBS не ответил (таймаут)`));
      }, Math.max(1_000, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._send(buildRequest(requestType, requestData, id));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  _assertConnected() {
    if (this.status !== 'connected' || !this._ws || this._ws.readyState !== 1) {
      throw new Error('OBS не подключён — проверь, что стрим запущен и WebSocket-сервер включён');
    }
  }

  /** Тот же адрес/пароль, что сейчас у подключённого клиента? (для переиспользования соединения) */
  sameConfig(host, port, password) {
    return `${host}:${port}:${password}` === this._cfgSig;
  }

  /** Список сцен OBS: { scenes: [имена], current: имя текущей }. */
  async getSceneList() {
    this._assertConnected();
    const data = await this._request('GetSceneList');
    const scenes = (Array.isArray(data?.scenes) ? data.scenes : [])
      .map((s) => String(s?.sceneName ?? ''))
      .filter(Boolean);
    return { scenes, current: data?.currentProgramSceneName ? String(data.currentProgramSceneName) : null };
  }

  /** Переключить текущую сцену по имени. */
  async setCurrentProgramScene(sceneName) {
    this._assertConnected();
    const name = String(sceneName || '').trim();
    if (!name) throw new Error('не указано имя сцены');
    await this._request('SetCurrentProgramScene', { sceneName: name });
  }

  /** Вкл/выкл источник в сцене (тумблер по имени сцены + имени источника). */
  async setSceneItemEnabled(sceneName, sourceName, enabled = true) {
    this._assertConnected();
    const scene = String(sceneName || '').trim();
    const source = String(sourceName || '').trim();
    if (!scene || !source) throw new Error('нужны имя сцены и имя источника');
    const items = await this._request('GetSceneItemList', { sceneName: scene });
    const item = (Array.isArray(items?.sceneItems) ? items.sceneItems : [])
      .find((it) => it?.sourceName === source);
    if (!item) throw new Error(`в сцене «${scene}» нет источника «${source}»`);
    await this._request('SetSceneItemEnabled', {
      sceneName: scene,
      sceneItemId: item.sceneItemId,
      sceneItemEnabled: Boolean(enabled),
    });
  }

  /**
   * Проверка связи для панели: подключиться (одноразово, без автопереподключений,
   * если клиент ещё не работает) и вернуть список сцен.
   */
  async test({ timeoutMs = 8_000 } = {}) {
    if (this.status === 'connected' && this._ws?.readyState === 1) return this.getSceneList();
    if (!this._shouldRun) {
      this._shouldRun = true;
      this._attempt = 0;
      this._cfgSig = this._sig();
      try {
        const ready = this._waitConnected(timeoutMs);
        this._connect();
        await ready;
        return await this.getSceneList();
      } finally {
        this.stop();
      }
    }
    // клиент уже работает и переподключается — дождёмся следующей попытки
    await this._waitConnected(timeoutMs);
    return this.getSceneList();
  }
}
