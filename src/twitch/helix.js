import { sleep } from '../store.js';

const API = 'https://api.twitch.tv/helix';
const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAYS = [1_000, 3_000]; // паузы перед повторами GET при сетевых сбоях

export class HelixError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'HelixError';
    this.status = status;
    this.body = body;
  }
}

/** Голые «fetch failed»/«operation aborted» переводим в понятный русский текст.
 *  Возвращает HelixError для сетевых сбоёв и таймаутов, null — для прочих ошибок. */
export function friendlyNetworkError(e, url) {
  // AbortSignal.timeout() рвёт fetch DOMException-ом TimeoutError (в старых версиях AbortError)
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new HelixError(
      `Twitch не ответил за ${Math.round(FETCH_TIMEOUT_MS / 1000)} сек — проверь интернет; если Twitch режется провайдером, включи прокси (Настройки → Прокси)`,
      0
    );
  }
  // Node оборачивает сетевые сбои в TypeError: fetch failed, реальная причина — в e.cause
  if (e instanceof TypeError || /fetch failed/i.test(e?.message || '')) {
    const code = e?.cause?.code;
    const host = url?.hostname || 'api.twitch.tv';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new HelixError(`не удалось найти адрес Twitch (${host}) — нет интернета, DNS или блокировка провайдера`, 0);
    }
    if (code === 'ECONNREFUSED') {
      return new HelixError('соединение отклонено — firewall/антивирус блокирует бота', 0);
    }
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return new HelixError('Twitch не ответил — связь медленная или режется', 0);
    }
    return new HelixError(`сеть недоступна: ${e?.cause?.message || e?.message || 'неизвестная сетевая ошибка'}`, 0);
  }
  return null;
}

/**
 * Тонкий клиент Helix API. Токен берёт из AuthManager (авто-refresh),
 * при 401 — одна попытка обновить токен и повторить запрос.
 */
export class Helix {
  constructor({ auth }) {
    this.auth = auth;
    this._userCache = new Map();
    this._sendQueue = [];
    this._draining = false;
    this._lastSendAt = 0;
  }

  async call(method, path, { query, body } = {}) {
    const url = new URL(API + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item)); // повторяющиеся ключи (user_login=a&user_login=b)
        } else url.searchParams.set(k, String(v));
      }
    }
    const doFetch = async () => {
      const token = await this.auth.ensureValid();
      if (!token) throw new HelixError('Бот не авторизован — войдите через панель', 401);
      const headers = {
        'Client-Id': this.auth.clientId,
        Authorization: `Bearer ${token}`,
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return this._fetchNetwork(url, method, headers, body === undefined ? undefined : JSON.stringify(body));
    };
    let res = await doFetch();
    if (res.status === 401) {
      await this.auth.refresh();
      res = await doFetch();
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.message || json?.error || `HTTP ${res.status}`;
      throw new HelixError(msg, res.status, json);
    }
    return json;
  }

  /** fetch с человеческими текстами сетевых ошибок и ретраями.
   *  Повторяем только сетевые сбои/таймауты (НЕ HTTP 4xx/5xx — их отдаёт уже сам Twitch)
   *  и только GET: POST (чат/награды) не дублируем, чтобы сообщения не задваивались. */
  async _fetchNetwork(url, method, headers, body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetch(url, { method, headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (e) {
        const friendly = friendlyNetworkError(e, url);
        if (!friendly || method !== 'GET' || attempt >= RETRY_DELAYS.length) {
          throw friendly ?? e; // нераспознанные ошибки пробрасываем как есть
        }
        await sleep(RETRY_DELAYS[attempt]);
      }
    }
  }

  // ---------- users / streams ----------

  async getUserByLogin(login) {    const key = String(login || '').toLowerCase();
    const cached = this._userCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.user;
    const json = await this.call('GET', '/users', { query: { login: key } });
    const user = json?.data?.[0] ?? null;
    if (user) {
      this._userCache.set(key, { at: Date.now(), user });
      // критик: кэш растёт бесконечно — держим разумный размер
      if (this._userCache.size > 300) this._userCache.delete(this._userCache.keys().next().value);
    }
    return user;
  }

  async getStreamByLogin(login) {
    const key = String(login).toLowerCase();
    const cached = this._streamCache?.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.stream;
    const json = await this.call('GET', '/streams', { query: { user_login: key } });
    const stream = json?.data?.[0] ?? null;
    this._streamCache = this._streamCache ?? new Map();
    this._streamCache.set(key, { at: Date.now(), stream });
    return stream;
  }

  /** Несколько каналов одним запросом: [{ user_id, user_login, started_at, title, game_name }…]. Без кэша — для трекера эфира. */
  async getStreamsByLogins(logins) {
    const items = (Array.isArray(logins) ? logins : [logins]).map((l) => String(l || '')).filter(Boolean);
    if (!items.length) return [];
    const json = await this.call('GET', '/streams', { query: { user_login: items.map((l) => l.toLowerCase()) } });
    return json?.data ?? [];
  }

  // ---------- chat ----------

  /** Отправка сообщения от имени бота. pin=true — закрепить на 20 минут (официальное поведение эндпоинта). */
  sendMessage({ broadcasterId, senderId, text, pin = false }) {
    return this._enqueue(async () => {
      const json = await this.call('POST', '/chat/messages', {
        body: {
          broadcaster_id: broadcasterId,
          sender_id: senderId,
          message: String(text).slice(0, 500),
          ...(pin ? { pin: true } : {}),
        },
      });
      const row = json?.data?.[0];
      if (row && row.is_sent === false) {
        const reason = row.drop_reason?.message || 'сообщение отклонено Twitch';
        throw new HelixError(`Сообщение не отправлено: ${reason}`, 200, row);
      }
      return row ?? {};
    });
  }

  /** Цветное системное объявление в чате (анонс). */
  announce({ broadcasterId, moderatorId, text, color = 'primary' }) {
    return this._enqueue(async () =>
      this.call('POST', '/chat/announcements', {
        query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        body: { message: String(text).slice(0, 500), color },
      })
    );
  }

  /** Настоящий шатаут Twitch (всплывающая карточка + кнопка Follow). */
  shoutout({ fromId, toUserId, moderatorId }) {
    return this.call('POST', '/chat/shoutouts', {
      query: {
        from_broadcaster_id: fromId,
        to_broadcaster_id: toUserId,
        moderator_id: moderatorId,
      },
    });
  }

  async pinMessage({ broadcasterId, moderatorId, messageId, durationSeconds }) {
    const query = {
      broadcaster_id: broadcasterId,
      moderator_id: moderatorId,
      message_id: messageId,
    };
    if (durationSeconds) {
      query.duration_seconds = Math.min(1800, Math.max(30, Math.round(durationSeconds)));
    }
    return this.call('PUT', '/chat/pins', { query });
  }

  unpinMessage({ broadcasterId, moderatorId, messageId }) {
    return this.call('DELETE', '/chat/pins', {
      query: { broadcaster_id: broadcasterId, moderator_id: moderatorId, message_id: messageId },
    });
  }

  async getPinned({ broadcasterId, moderatorId }) {
    const json = await this.call('GET', '/chat/pins', {
      query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
    });
    return json?.data?.[0] ?? null;
  }

  // ---------- followers ----------

  /** Возвращает {followed_at, user_login, ...}|null — подписан ли user на broadcaster. */
  async getFollower({ broadcasterId, userId }) {
    const json = await this.call('GET', '/channels/followers', {
      query: { broadcaster_id: broadcasterId, user_id: userId },
    });
    return json?.data?.[0] ?? null;
  }

  async getFollowersTotal({ broadcasterId }) {
    const json = await this.call('GET', '/channels/followers', {
      query: { broadcaster_id: broadcasterId },
    });
    return Number(json?.total ?? 0);
  }

  // ---------- eventsub ----------

  createSubscription({ type, version, condition, sessionId }) {
    return this.call('POST', '/eventsub/subscriptions', {
      body: {
        type,
        version,
        condition,
        transport: { method: 'websocket', session_id: sessionId },
      },
    });
  }

  async listSubscriptions() {
    const all = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const query = { first: 100 };
      if (after) query.after = after;
      const json = await this.call('GET', '/eventsub/subscriptions', { query });
      all.push(...(json?.data ?? []));
      after = json?.pagination?.cursor ?? null;
      if (!after) break;
    }
    return all;
  }

  deleteSubscription(id) {
    return this.call('DELETE', '/eventsub/subscriptions', { query: { id } });
  }

  // ---------- очередь отправки ----------

  /** Не спамим: минимум 1.5с между исходящими сообщениями (лимит обычного бота 20/30с). */
  _enqueue(job) {
    // критик: очередь без капа копится при лежащем Twitch — режем хвост
    while (this._sendQueue.length >= 20) {
      const dropped = this._sendQueue.shift();
      dropped.reject(new HelixError('Очередь отправки переполнена — сообщение отброшено', 429));
    }
    return new Promise((resolve, reject) => {
      this._sendQueue.push({ job, resolve, reject, at: Date.now() });
      this._drain();
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._sendQueue.length) {
        const { job, resolve, reject, at } = this._sendQueue.shift();
        // протухшие задания (провайдер лежал) не отправляем — не выплёвываем стенные реплики часами
        if (Date.now() - at > 120_000) {
          reject(new HelixError('Сообщение устарело в очереди отправки', 429));
          continue;
        }
        const wait = this._lastSendAt ? 1500 - (Date.now() - this._lastSendAt) : 0;
        if (wait > 0) await sleep(wait);
        try {
          resolve(await job());
        } catch (e) {
          reject(e);
        }
        this._lastSendAt = Date.now();
      }
    } finally {
      this._draining = false;
    }
  }
}
