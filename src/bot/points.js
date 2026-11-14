import { loadJson, saveJson } from '../store.js';
import { POINTS_FILE } from '../store.js';
import { overlay } from './alerts.js';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Баллы канала:_nvrl начисление за просмотр (+ за сообщения), топ, передачи,
 * колесо-рулетка и мем-магазин — трата баллов на алерты/эффекты.
 * Хранение: data/points.json { login: { points, name, watchedMin } }.
 */
export class PointsManager {
  constructor({ helix, auth, logs, settings, channels, dataFile = POINTS_FILE }) {
    this.helix = helix;
    this.auth = auth;
    this.logs = logs;
    this.settings = settings; // живой объект настроек (points/wheel/memShop)
    this.channels = channels;
    this.dataFile = dataFile;
    this.store = loadJson(this.dataFile, {}) ?? {};
    this._dirty = false;
    this._timer = null;
    this._flush = null;
    this._wheelLast = new Map(); // userId -> ts последнего спина
    this._dataDirOk = true;
  }

  // ---------------- хранение ----------------

  _ensure(login, name = '') {
    const key = String(login || '').toLowerCase().replace(/^@/, '');
    if (!key) return null;
    if (!this.store[key]) this.store[key] = { points: 0, name: name || key, watchedMin: 0 };
    if (name && this.store[key].name !== name) this.store[key].name = name;
    return key;
  }

  add(login, delta, name = '') {
    const key = this._ensure(login, name);
    if (!key) return 0;
    this.store[key].points = Math.max(0, Math.round((this.store[key].points || 0) + delta));
    this._dirty = true;
    return this.store[key].points;
  }

  balance(login) {
    return this.store[String(login || '').toLowerCase().replace(/^@/, '')]?.points ?? 0;
  }

  spend(login, amount) {
    const key = this._ensure(login);
    if (!key) return false;
    const n = Math.round(Number(amount) || 0);
    if (n <= 0 || (this.store[key].points || 0) < n) return false;
    this.store[key].points -= n;
    this._dirty = true;
    return true;
  }

  transfer(from, to, amount, toName = '') {
    const f = String(from || '').toLowerCase().replace(/^@/, '');
    const t = this._ensure(to, toName);
    const n = Math.round(Number(amount) || 0);
    if (!t || f === t || n <= 0) return { ok: false, error: 'не тот получатель или сумма' };
    if ((this.store[f]?.points || 0) < n) return { ok: false, error: 'не хватает баллов' };
    this.store[f].points -= n;
    this.store[t].points = (this.store[t].points || 0) + n;
    this._dirty = true;
    return { ok: true, to: t, amount: n, balance: this.store[f].points };
  }

  top(n = 10) {
    return Object.entries(this.store)
      .map(([login, v]) => ({ login, ...(typeof v === 'object' ? v : { points: v }) }))
      .filter((v) => (v.points || 0) > 0)
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .slice(0, Math.max(1, Math.min(50, Number(n) || 10)));
  }

  saveNow() {
    if (!this._dirty) return;
    try {
      saveJson(this.dataFile, this.store);
      this._dirty = false;
    } catch {}
  }

  // ---------------- начисление ----------------

  start() {
    if (this._timer) return;
    const tickMs = Math.max(1, Number(this.settings?.points?.intervalMin ?? 10)) * 60_000;
    this._timer = setInterval(() => { this.accrueTick().catch(() => {}); }, tickMs);
    this._flush = setInterval(() => this.saveNow(), 15_000);
    if (!fs.existsSync(path.dirname(this.dataFile))) this._dataDirOk = false;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._flush) clearInterval(this._flush);
    this._timer = this._flush = null;
    this.saveNow();
  }

  /** Бонус за сообщение в чате (мелкий, настройка points.perMessage; 0 = выкл). */
  noteMessage(login, name = '') {
    const per = Number(this.settings?.points?.perMessage ?? 1) || 0;
    if (!per) return;
    this.add(login, per, name);
  }

  /** Начисление за просмотр: всем в чате живых каналов — points.amount баллов. */
  async accrueTick() {
    const cfg = this.settings?.points;
    if (!cfg?.enabled) return;
    const amount = Math.max(0, Number(cfg.amount ?? 10));
    if (!amount || !this.channels?.list().length || !this.auth.tokens?.userId) return;
    for (const ch of this.channels.list()) {
      try {
        const stream = await this.helix.getStreamByLogin(ch.login).catch(() => null);
        if (!stream) continue; // оффлайн — баллы не капают
        const chatters = await this.helix.getChatters({ broadcasterId: ch.id, moderatorId: this.auth.tokens.userId });
        for (const c of chatters) {
          const key = this._ensure(c.login, c.name);
          if (!key) continue;
          if (key === String(this.auth.tokens.login || '').toLowerCase()) continue; // сам бот без баллов
          this.store[key].points = (this.store[key].points || 0) + amount;
          this.store[key].watchedMin = (this.store[key].watchedMin || 0) + Math.max(1, Number(cfg.intervalMin ?? 10));
          this._dirty = true;
        }
        this.logs.system.push({ level: 'info', message: `Баллы: +${amount} зрителям #${ch.login} (в чате: ${chatters.length})` });
      } catch (e) {
        this.logs.system.push({ level: 'warn', message: `Баллы не начислились (#${ch.login}): ${e.message}. Если про права — обнови вход бота (нужен скоуп moderator:read:chatters)` });
      }
    }
  }

  // ---------------- колесо ----------------

  /** Спин: ставка n баллов, исход взвешенно-случайный. Возвращает { item, delta }. */
  spin(login, name, bet) {
    const cfg = this.settings?.wheel;
    if (!cfg?.enabled) return { error: 'колесо выключено' };
    const b = Math.round(Number(bet) || 0);
    const min = Math.max(1, Number(cfg.minBet ?? 10));
    const max = Math.max(min, Number(cfg.maxBet ?? 1000));
    if (b < min) return { error: `минимальная ставка ${min}` };
    if (b > max) return { error: `максимум ставки ${max}` };
    const cd = Math.max(0, Number(cfg.cooldown ?? 60));
    const last = this._wheelLast.get(String(login).toLowerCase()) || 0;
    if (cd && Date.now() - last < cd * 1000) {
      const left = Math.ceil((cd * 1000 - (Date.now() - last)) / 1000);
      return { error: `охлади пыл — следующий спин через ${left} сек` };
    }
    if (!this.spend(login, b)) return { error: 'не хватает баллов' };

    const items = (cfg.items ?? []).filter((x) => x && Number(x.weight) > 0);
    const total = items.reduce((s, x) => s + Number(x.weight), 0);
    let roll = Math.random() * total;
    let picked = items[items.length - 1];
    for (const it of items) {
      roll -= Number(it.weight);
      if (roll <= 0) { picked = it; break; }
    }
    const mult = Math.max(0, Number(picked.multiplier ?? 0));
    const delta = mult * b - b; // чистое изменение (ставка уже списана)
    if (mult > 0) this.add(login, mult * b, name);
    this._wheelLast.set(String(login).toLowerCase(), Date.now());
    return { item: picked, delta, bet: b, multiplier: mult };
  }

  // ---------------- мем-магазин ----------------

  /** Покупка мем-алерта: списываем цену и кидаем кастомный алерт в оверлей. */
  buyMeme(login, name, itemName) {
    const cfg = this.settings?.memShop;
    if (!cfg?.enabled) return { error: 'магазин выключен' };
    const wanted = String(itemName || '').trim().toLowerCase();
    const items = (cfg.items ?? []).filter((x) => x && x.enabled !== false && x.name);
    const item = wanted ? items.find((x) => String(x.name).toLowerCase() === wanted) : null;
    if (!item) {
      return { list: items.map((x) => `${x.name} — ${x.price}${x.text ? ` (${x.text})` : ''}`) };
    }
    const price = Math.max(0, Number(item.price ?? 0));
    if (!this.spend(login, price)) return { error: `нужно ${price} баллов, а у тебя меньше` };
    const who = name || login;
    overlay.push({
      kind: 'meme',
      channel: null,
      user: who,
      text: String(item.text || 'мем 🎉').replaceAll('{user}', who),
      sound: String(item.sound || ''),
    });
    this.logs.events.push({ kind: 'мем-магазин', text: `${who} купил «${item.name}» за ${price} балл(ов)` });
    return { item, price };
  }
}
