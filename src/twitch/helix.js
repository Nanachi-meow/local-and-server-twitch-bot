import { sleep } from '../store.js';

const API = 'https://api.twitch.tv/helix';

export class HelixError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'HelixError';
    this.status = status;
    this.body = body;
  }
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
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
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
      return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

  // ---------- users / streams ----------

  async getUserByLogin(login) {    const key = String(login || '').toLowerCase();
    const cached = this._userCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.user;
    const json = await this.call('GET', '/users', { query: { login: key } });
    const user = json?.data?.[0] ?? null;
    if (user) this._userCache.set(key, { at: Date.now(), user });
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

  /** Активные зрители чата (для баллов за просмотр). Нужно: moderator:read:chatters + бот-модератор. */
  async getChatters({ broadcasterId, moderatorId, limit = 500 }) {
    const out = [];
    let cursor;
    for (let page = 0; page < 5 && out.length < limit; page += 1) {
      const json = await this.call('GET', '/chat/chatters', {
        query: { broadcaster_id: broadcasterId, moderator_id: moderatorId, first: 100, after: cursor },
      });
      for (const c of json?.data ?? []) out.push({ login: c.user_login, name: c.user_name });
      cursor = json?.pagination?.cursor;
      if (!cursor) break;
    }
    return out;
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
    return new Promise((resolve, reject) => {
      this._sendQueue.push({ job, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._sendQueue.length) {
        const { job, resolve, reject } = this._sendQueue.shift();
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
