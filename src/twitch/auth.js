import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TOKENS_FILE, loadJson, saveJson } from '../store.js';

/** Скоупы, которые просим у бота при входе.
 *  user:read/write:chat — читать и писать чат через официальный Chat Bot API.
 *  moderator:* — фоллоу-ивенты, шатауты, анонсы, закрепы (бот должен быть модератором канала).
 */
export const SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'moderator:read:followers',
  'moderator:read:chatters',
  'moderator:manage:shoutouts',
  'moderator:manage:announcements',
  'moderator:manage:chat_messages',
];

const ID_URL = 'https://id.twitch.tv';

export class AuthError extends Error {}

export class AuthManager {
  constructor({ clientId, clientSecret }) {
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    /** @type {{accessToken, refreshToken, expiresAt, userId, login, displayName, scopes}|null} */
    this.tokens = null;
    this.status = 'none'; // none | ok | expired | error
    this.lastError = null;
    this._pendingState = null;
  }

  updateClient({ clientId, clientSecret }) {
    if (clientId !== undefined && clientId !== this.clientId) {
      // токены привязаны к старому приложению — сбрасываем
      this.tokens = null;
      this.status = 'none';
    }
    if (clientId !== undefined) this.clientId = clientId;
    if (clientSecret !== undefined) this.clientSecret = clientSecret;
  }

  load() {
    this.tokens = loadJson(TOKENS_FILE, null);
    if (this.tokens) this.status = 'ok';
    return this.tokens;
  }

  persist() {
    if (this.tokens) saveJson(TOKENS_FILE, this.tokens);
  }

  logout() {
    this.tokens = null;
    this.status = 'none';
    this.lastError = null;
    try {
      fs.rmSync(TOKENS_FILE, { force: true });
    } catch {}
  }

  redirectUri(port) {
    return `http://localhost:${port}/auth/callback`;
  }

  beginAuth(port) {
    const state = randomUUID();
    this._pendingState = state;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri(port),
      scope: SCOPES.join(' '),
      state,
    });
    return `${ID_URL}/oauth2/authorize?${params.toString()}`;
  }

  checkState(state) {
    return this._pendingState !== null && state === this._pendingState;
  }

  async exchangeCode(code, port) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(port),
    });
    const res = await fetch(`${ID_URL}/oauth2/token`, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.status = 'error';
      this.lastError = json.message || `HTTP ${res.status}`;
      throw new AuthError(`Не удалось обменять код на токен: ${this.lastError}`);
    }
    this._applyTokens(json);
    await this.validate();
    this.persist();
    return this.tokens;
  }

  async refresh() {
    if (!this.tokens?.refreshToken) {
      this.status = 'expired';
      throw new AuthError('Нет refresh-токена — нужен повторный вход через панель');
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
    });
    const res = await fetch(`${ID_URL}/oauth2/token`, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.status = 'expired';
      this.lastError = json.message || `HTTP ${res.status}`;
      throw new AuthError(`Не удалось обновить токен: ${this.lastError}`);
    }
    this._applyTokens(json);
    this.persist();
    return this.tokens;
  }

  _applyTokens(json) {
    this.tokens = {
      ...this.tokens,
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? this.tokens?.refreshToken ?? null,
      expiresAt: Date.now() + (json.expires_in ?? 14400) * 1000,
      scopes: json.scope ?? this.tokens?.scopes ?? [],
    };
    this.status = 'ok';
    this.lastError = null;
  }

  async validate() {
    if (!this.tokens) return null;
    let res = await fetch(`${ID_URL}/oauth2/validate`, {
      headers: { Authorization: `Bearer ${this.tokens.accessToken}` },
    });
    if (!res.ok) {
      await this.refresh();
      res = await fetch(`${ID_URL}/oauth2/validate`, {
        headers: { Authorization: `Bearer ${this.tokens.accessToken}` },
      });
    }
    if (!res.ok) {
      this.status = 'error';
      this.lastError = `validate: HTTP ${res.status}`;
      throw new AuthError('Токен невалиден даже после обновления');
    }
    const json = await res.json();
    this.tokens.userId = json.user_id;
    this.tokens.login = json.login;
    this.tokens.scopes = Array.isArray(json.scopes) ? json.scopes : [];
    this.tokens.expiresAt = Date.now() + (json.expires_in ?? 0) * 1000;
    this.status = 'ok';
    return json;
  }

  /** Возвращает актуальный access-токен (обновляет, если скоро истечёт). */
  async ensureValid() {
    if (!this.tokens) {
      this.load();
    }
    if (!this.tokens) return null;
    if (this.tokens.expiresAt - Date.now() < 120_000) {
      await this.refresh();
    }
    return this.tokens.accessToken;
  }
}
