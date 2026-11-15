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
    const d = Math.round(Number(delta));
    if (!Number.isFinite(d) || d === 0) return this.store[key].points || 0; // критик: !дать 1e400 не ломает баланс
    this.store[key].points = Math.max(0, Math.min(1_000_000_000, (this.store[key].points || 0) + d));
    this._dirty = true;
    return this.store[key].points;
  }

  balance(login) {
    return this.store[String(login || '').toLowerCase().replace(/^@/, '')]?.points ?? 0;
  }

  spend(login, amount) {
    const key = this._ensure(login);
    if (!key) return false;
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n <= 0 || (this.store[key].points || 0) < n) return false;
    this.store[key].points -= n;
    this._dirty = true;
    return true;
  }

  async transfer(from, to, amount, toName = '') {
    const f = String(from || '').toLowerCase().replace(/^@/, '');
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'не та сумма' };
    // критик: не создаём мёртвый кошелёк на опечатку — проверяем, что получатель существует
    if (this.helix?.getUserByLogin) {
      try {
        const u = await this.helix.getUserByLogin(String(to || '').replace(/^@/, ''));
        if (!u) return { ok: false, error: `не знаю пользователя "${to}" 🤷` };
        toName = u.display_name || toName;
      } catch { /* API недоступен — не блокируем перевод */ }
    }
    const t = this._ensure(to, toName);
    if (!t || f === t) return { ok: false, error: 'не тот получатель' };
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
    if (!this._timer) {
      const tickMs = Math.max(1, Number(this.settings?.points?.intervalMin ?? 10)) * 60_000;
      this._timer = setInterval(() => { this.accrueTick().catch(() => {}); }, tickMs);
    }
    if (!this._flush) this._flush = setInterval(() => this.saveNow(), 15_000);
    if (!fs.existsSync(path.dirname(this.dataFile))) this._dataDirOk = false;
  }

  /** Критик: смена интервала в панели применяется без перезапуска бота. */
  rearm() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.start();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._flush) clearInterval(this._flush);
    this._timer = this._flush = null;
    this.saveNow();
  }

  /** Бонус за сообщение в чате (мелкий, настройка points.perMessage; 0 = выкл). */
  noteMessage(login, name = '') {
    const cfg = this.settings?.points; // критик: выключенные баллы не капают, сам себя бот не начисляет
    if (!cfg?.enabled) return;
    if (!login || String(login).toLowerCase() === String(this.auth?.tokens?.login || '').toLowerCase()) return;
    const per = Math.max(0, Math.min(10, Number(cfg.perMessage ?? 1) || 0));
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
    const items = (cfg.items ?? []).filter((x) => x && Number(x.weight) > 0);
    if (!items.length) return { error: 'колесо не настроено: нет вариантов с весом — ставка не списана' }; // критик: не жжём ставку
    if (!this.spend(login, b)) return { error: 'не хватает баллов' };

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
    if (this._wheelLast.size > 500) {
      const cut = Date.now() - 86_400_000;
      for (const [k, ts] of this._wheelLast) if (ts < cut) this._wheelLast.delete(k);
    }
    return { item: picked, delta, bet: b, multiplier: mult };
  }

  // ---------------- мем-магазин ----------------

  /** Покупка мем-алерта: списываем цену и кидаем кастомный алерт в оверлей. */
  buyMeme(login, name, itemName) {
    const cfg = this.settings?.memShop;
    if (!cfg?.enabled) return { error: 'магазин выключен' };
    // критик: кулдаун покупок — без него TTS и алерты задолбают чат
    const cd = Math.max(0, Math.min(3600, Number(cfg.cooldown ?? 0)));
    if (cd) {
      const key = String(login || '').toLowerCase();
      const last = this._memeLast?.get(key) || 0;
      if (Date.now() - last < cd * 1000) {
        const left = Math.ceil((cd * 1000 - (Date.now() - last)) / 1000);
        return { error: `мемы не чаще раза в ${cd} сек — подожди ${left} сек` };
      }
      this._memeLast = this._memeLast ?? new Map();
      this._memeLast.set(key, Date.now());
      if (this._memeLast.size > 500) {
        const cut = Date.now() - 86_400_000;
        for (const [k, ts] of this._memeLast) if (ts < cut) this._memeLast.delete(k);
      }
    }
    const wanted = String(itemName || '').trim().toLowerCase();
    const items = (cfg.items ?? []).filter((x) => x && x.enabled !== false && x.name);
    const item = wanted ? items.find((x) => String(x.name).toLowerCase() === wanted) : null;
    if (!item) {
      return { list: items.map((x) => `${x.name} — ${x.price}${x.text ? ` (${x.text})` : ''}`) };
    }
    const price = Math.max(0, Number(item.price ?? 0));
    if (!overlay.clients.size) return { error: 'оверлей не открыт (добавь его в OBS или открой в браузере) — баллы не списаны' }; // критик: не жжём баллы в никуда
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
