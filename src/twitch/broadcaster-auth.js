import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BROADCASTER_TOKENS_FILE, loadJson, saveJson } from '../store.js';

/** Скоупы второго входа — «Вход как стример».
 *  channel:read:redemptions — видеть списания наград канала (EventSub channel points).
 *  user:read:chat — читать чат (базовый скоуп чтения от имени зрителя).
 */
export const BROADCASTER_SCOPES = [
  'channel:read:redemptions',
  'channel:manage:redemptions', // отмена списания — возврат баллов зрителю при отказе заказа
  'user:read:chat',
];

const ID_URL = 'https://id.twitch.tv';

export class BroadcasterAuthError extends Error {}

/**
 * Второй OAuth-поток: вход под аккаунтом СТРИМЕРА (владельца канала).
 * Нужен, потому что Twitch отдаёт события списания наград канала
 * (channel.channel_points_custom_reward_redemption.add) только токену
 * владельца канала — токену бота-модератора они недоступны.
 *
 * Логика зеркалит AuthManager бота, но токены живут в data/broadcaster-tokens.json,
 * а redirect ведёт на /auth/broadcaster/callback.
 */
export class BroadcasterAuth {
  constructor({ clientId, clientSecret }) {
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    /** @type {{accessToken, refreshToken, expiresAt, userId, login, displayName, scopes}|null} */
    this.tokens = null;
    this.status = 'none'; // none | ok | expired | error
    this.lastError = null;
    this._pendingState = null;
    this._refreshTimer = null;
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
    this.tokens = loadJson(BROADCASTER_TOKENS_FILE, null);
    if (this.tokens) this.status = 'ok';
    return this.tokens;
  }

  persist() {
    if (this.tokens) saveJson(BROADCASTER_TOKENS_FILE, this.tokens);
  }

  logout() {
    this.tokens = null;
    this.status = 'none';
    this.lastError = null;
    try {
      fs.rmSync(BROADCASTER_TOKENS_FILE, { force: true });
    } catch {}
  }

  redirectUri(port) {
    return `http://localhost:${port}/auth/broadcaster/callback`;
  }

  beginAuth(port) {
    const state = randomUUID();
    this._pendingState = state;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri(port),
      scope: BROADCASTER_SCOPES.join(' '),
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
      throw new BroadcasterAuthError(`Не удалось обменять код на токен стримера: ${this.lastError}`);
    }
    this._applyTokens(json);
    await this.validate();
    this.persist();
    return this.tokens;
  }

  async refresh() {
    if (!this.tokens?.refreshToken) {
      this.status = 'expired';
      throw new BroadcasterAuthError('Нет refresh-токена стримера — нужен повторный «Вход как стример»');
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
      throw new BroadcasterAuthError(`Не удалось обновить токен стримера: ${this.lastError}`);
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
      throw new BroadcasterAuthError('Токен стримера невалиден даже после обновления');
    }
    const json = await res.json();
    this.tokens.userId = json.user_id;
    this.tokens.login = json.login;
    this.tokens.scopes = Array.isArray(json.scopes) ? json.scopes : [];
    this.tokens.expiresAt = Date.now() + (json.expires_in ?? 0) * 1000;
    this.status = 'ok';
    return json;
  }

  /** Возвращает актуальный access-токен стримера (обновляет, если скоро истечёт). */
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

  /**
   * Автообновление токена: раз в 5 минут проверяет, не истекает ли он
   * (за 15 минут до конца — refresh), как у токена бота в index.js.
   * onLog — (level, message).
   */
  autoRefresh(onLog = () => {}) {
    this.stopAutoRefresh();
    this._refreshTimer = setInterval(async () => {
      if (!this.tokens || this.tokens.expiresAt - Date.now() >= 15 * 60_000) return;
      try {
        await this.refresh();
        onLog('info', 'Токен стримера обновлён автоматически');
      } catch (e) {
        onLog('error', `Не удалось обновить токен стримера: ${e.message}`);
      }
    }, 5 * 60_000);
    this._refreshTimer.unref?.();
  }

  stopAutoRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  }
}
