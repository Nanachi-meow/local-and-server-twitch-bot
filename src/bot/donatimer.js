/**
 * ⏱ Таймер донатона: сколько стриму осталось жить.
 *
 * Логика времени:
 *   • секунд осталось = базаМинут + (всего донатов ₽ / цена минуты) − (прошло сек)
 *   • старт/пауза автоматом от LiveTracker: стрим начался → тикает; кончился → пауза
 *   • донаты добавляют время (каждый источник приводит сумму в ₽), ручные ±минуты тоже
 *
 * Источники донатов (мульти, каждый включается отдельно):
 *   • donatex  — токен из кабинета donatex.gg, опрос /api/v1/donations?period=CurrentStream
 *   • da      — DonationAlerts API-токен, опрос /api/v1/alert/donations
 *   • donatepay — токен, опрос /api/v1/transactions
 *   • manual  — кнопка/команда в панели: +сумма (время добавляется по курсу)
 * В один стрим донат считается один раз (по id от источника), между стримами
 * счётчик донатов обнуляется (время «этого» стрима живёт в состояния стрима).
 */
import { overlay } from './alerts.js';

const CUR = { RUB: 1, USD: 92, EUR: 100, KZT: 0.19, UAH: 2.2, BYN: 30 }; // грубые курсы к рублю

export function toRub(amount, currency = 'RUB') {
  const n = Number(amount) || 0;
  const k = CUR[String(currency || 'RUB').toUpperCase()] ?? 1;
  return Math.round(n * k * 100) / 100;
}

export class DonaTimer {
  constructor({ logs, settings, live, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
    this.logs = logs;
    this.settings = settings; // живой объект (settings.donaTimer, settings.donations)
    this.live = live;
    this.fetcher = fetcher;
    this._tick = null;        // setInterval 1 сек
    this._poll = null;        // setInterval опроса источников
    this._seen = new Set();   // id донатов этого стрима (анти-дубль)
    this._lastShownSec = null;
    this._load();
  }

  cfg() { return this.settings?.donaTimer ?? {}; }
  srcCfg() { return this.settings?.donations ?? {}; }

  // ---------- хранение (data/donatimer.json делает index.js) ----------
  _store() { return this._state; }
  _load(stored = {}) {
    this._state = {
      pausedAtSec: 0,   // сколько секунд оставалось, когда поставили на паузу
      running: false,    // тикает ли сейчас (стрим в эфире)
      startedAt: null,   // когда начали тикать (для вычитания прошедших секунд)
      totalRub: 0,       // сумма донатов этого стрима, ₽
      manualSec: 0,      // ручные добавки/списания времени, сек (может быть < 0)
      ...(stored ?? {}),
    };
  }
  setStoreSave(fn) { this._save = fn; }
  saveNow() { try { this._save?.(); } catch { /* лог не должен ронять таймер */ } }

  /** Полное оставшееся время, сек (без вычета прошедшего, если на паузе). */
  secondsLeft() {
    const base = Math.max(0, Number(this.cfg().baseMinutes ?? 0)) * 60;
    const perMin = Math.max(1, Number(this.cfg().pricePerMinute ?? 30));
    const donatedSec = Math.floor((this._state.totalRub / perMin) * 60);
    const total = base + donatedSec + this._state.manualSec;
    if (!this._state.running || !this._state.startedAt) return Math.max(0, this._state.pausedAtSec);
    return Math.max(0, Math.round(total - (Date.now() - this._state.startedAt) / 1000));
  }

  // ---------- стрим пошёл/кончился ----------
  onStreamStart() {
    if (this.cfg().enabled === false) return;
    this._state.running = true;
    this._state.startedAt = Date.now();
    this._state.pausedAtSec = 0;
    this._seen.clear();
    this._state.totalRub = 0;
    this._state.manualSec = 0;
    this.saveNow();
    this.push(true);
    this.start();
  }
  onStreamEnd() {
    // фикс: сначала фиксируем остаток (secondsLeft зависит от running), потом гасим
    const left = this.secondsLeft();
    this._state.running = false;
    this._state.pausedAtSec = left;
    this._state.startedAt = null;
    this.saveNow();
    this.push(true);
    this.stop();
  }

  // ---------- тик ----------
  start() {
    if (this._tick || this.cfg().enabled === false) return;
    this._tick = setInterval(() => {
      const s = this.secondsLeft();
      if (s !== this._lastShownSec) {
        this._lastShownSec = s;
        this.push();
        if (s <= 0) {
          this.logs?.events?.push?.({ kind: 'таймер', channel: null, text: '⏱ Таймер донатона дошёл до нуля!' });
          this.stop(); // ноль — тикать бессмысленно, пока не добавят времени
        }
      }
    }, 1000);
    this.startPolling();
  }
  stop() {
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
    this.stopPolling();
  }

  // ---------- донаты ----------
  /** Донат от источника (id — уникальный ключ источника). Возвращает true, если новый. */
  addDonation({ id, amount, currency = 'RUB', name = '', message = '' }) {
    if (!id || this._seen.has(id)) return false;
    this._seen.add(id);
    const rub = toRub(amount, currency);
    this._state.totalRub = Math.round((this._state.totalRub + rub) * 100) / 100;
    this.saveNow();
    const perMin = Math.max(1, Number(this.cfg().pricePerMinute ?? 30));
    this.logs?.events?.push?.({
      kind: 'донат',
      channel: null,
      text: `💰 ${name || 'кто-то'} — ${rub}₽ (+${Math.floor((rub / perMin) * 60)} сек таймеру)${message ? `: ${message.slice(0, 80)}` : ''}`,
    });
    this.push(true);
    return true;
  }

  /** Ручное добавление/списание времени (сек; может быть отрицательным). */
  addManualSec(sec) {
    const n = Math.round(Number(sec) || 0);
    if (!n) return { error: 'ноль секунд — не считается' };
    this._state.manualSec += n;
    this.saveNow();
    this.push(true);
    if (n > 0 && this.secondsLeft() > 0 && !this._tick) this.start();
    return { ok: true };
  }

  /** Ручной донат из панели (считается как обычный, но отдельный id). */
  addManualDonation({ amount, name = 'вручную' }) {
    const rub = toRub(amount);
    if (!rub) return { error: 'сумма должна быть больше нуля' };
    return this.addDonation({ id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, amount: rub, currency: 'RUB', name });
  }

  // ---------- опрос источников ----------
  startPolling() {
    if (this._poll || this.cfg().enabled === false) return;
    this._poll = setInterval(() => this.pollSources().catch(() => {}), 15_000);
    this.pollSources().catch(() => {});
  }
  stopPolling() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
  }

  async pollSources() {
    const sc = this.srcCfg();
    if (sc.donatex?.enabled && sc.donatex?.token) await this._pollDonatex(sc.donatex.token).catch(() => {});
    if (sc.da?.enabled && sc.da?.token) await this._pollDa(sc.da.token).catch(() => {});
    if (sc.donatepay?.enabled && sc.donatepay?.token) await this._pollDonatepay(sc.donatepay.token).catch(() => {});
  }

  async _pollDonatex(token) {
    const r = await this.fetcher('https://donatex.gg/api/v1/donations?skip=0&take=25&period=CurrentStream&hideTest=false', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`donatex HTTP ${r.status}`);
    const list = await r.json().catch(() => []);
    for (const d of (Array.isArray(list) ? list : [])) {
      this.addDonation({
        id: `donatex-${d.id}`,
        amount: Number(d.amountInRub ?? d.amount) || 0,
        currency: d.amountInRub != null ? 'RUB' : (d.currency || 'RUB'),
        name: d.username || '',
        message: d.message || '',
      });
    }
  }

  async _pollDa(token) {
    const r = await this.fetcher('https://www.donationalerts.com/api/v1/alert/donations?limit=25', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`DA HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    for (const d of (j?.data ?? [])) {
      this.addDonation({
        id: `da-${d.id}`,
        amount: Number(d.amount) || 0,
        currency: d.currency || 'RUB',
        name: d.username || '',
        message: d.message || '',
      });
    }
  }

  async _pollDonatepay(token) {
    const r = await this.fetcher(`https://donatepay.ru/api/v1/transactions?access_token=${encodeURIComponent(token)}&limit=25&sort=d-desc`);
    if (!r.ok) throw new Error(`DonatePay HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    for (const d of (j?.data ?? [])) {
      if (d?.status !== 'success' && d?.type !== 'donation') continue;
      this.addDonation({
        id: `dpay-${d.id}`,
        amount: Number(d.amount ?? d.sum) || 0,
        currency: d.currency || 'RUB',
        name: d.username ?? d.vars?.name ?? '',
        message: d.comment ?? '',
      });
    }
  }

  // ---------- состояние для панели/оверлея ----------
  state() {
    const cfg = this.cfg();
    return {
      enabled: cfg.enabled === true,
      running: this._state.running,
      secondsLeft: this.secondsLeft(),
      totalRub: this._state.totalRub,
      label: cfg.label ?? 'стрим закончится через',
      footer: cfg.footer ?? `продлить стрим: {price}₽ за минуту`
        .replaceAll('{price}', String(Math.max(1, Number(cfg.pricePerMinute ?? 30)))),
      accent: cfg.accent ?? '#ff5a4d',
    };
  }

  /** Пуш в оверлей (kind: 'donatimer'). */
  push(force = false) {
    if (this.cfg().enabled !== true) return;
    overlay.push({ kind: 'donatimer', force, ...this.state() });
  }
}
