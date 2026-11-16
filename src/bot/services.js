import { loadJson, saveJson } from '../store.js';
import { SERVICES_FILE } from '../store.js';

/**
 * Магазин услуг (redemption store) за баллы канала: data/services.json.
 *
 * items:  [{ id, name, price, stock, enabled, text }]
 *   stock: 0 = бесконечно; N > 0 = сколько осталось; -1 = распродано
 *   (когда последняя единица куплена, stock становится -1, а не 0 — иначе 0
 *   означал бы снова «бесконечно»).
 * orders: [{ id, login, name, service, price, at, status }]
 *   status: 'pending' (ждёт выполнения) | 'done' (выполнено, остаётся как история).
 *   Возврат баллов убирает заказ совсем — «выполненным» он не считается.
 *
 * Списание при покупке и возврат при отмене делает менеджер сам через
 * PointsManager; выполненные заказы подтверждает стример из панели
 * (кнопки «✅ Выполнено» / «↩ Вернуть баллы» → действие 'serviceorder').
 */
const MAX_PENDING_PER_USER = 5; // сколько заказов может одновременно ждать один зритель
const MAX_ITEMS = 30;
const KEEP_DONE = 50; // сколько выполненных заказов держим в истории

function defaultItems() {
  // примеры выключены: пока стример не настройт услуги, купить ничего нельзя
  return [
    { id: 'svc-duet', name: 'дуэт', price: 500, stock: 0, enabled: false, text: 'сыграть одну катку со стримером' },
    { id: 'svc-advice', name: 'совет', price: 100, stock: 0, enabled: false, text: 'жизненный совет от стримера' },
  ];
}

export class ServicesManager {
  constructor({ logs = null, points = null, dataFile = SERVICES_FILE } = {}) {
    this.logs = logs;
    this.points = points; // PointsManager: spend при заказе, add при возврате
    this.dataFile = dataFile;
    const stored = loadJson(this.dataFile, null);
    const hadFile = stored !== null && typeof stored === 'object';
    const rawItems = hadFile ? (Array.isArray(stored.items) ? stored.items : []) : defaultItems();
    this.items = rawItems.map((it, i) => normalizeItem(it, i)).filter((it) => it.name);
    this.orders = (hadFile && Array.isArray(stored.orders) ? stored.orders : [])
      .map((o) => ({
        id: Math.floor(Number(o?.id) || 0),
        login: String(o?.login || '').toLowerCase().replace(/^@/, ''),
        name: String(o?.name || '').trim().slice(0, 40),
        service: String(o?.service || '').trim().slice(0, 32),
        price: Math.max(0, Math.round(Number(o?.price) || 0)),
        at: Math.floor(Number(o?.at) || 0),
        status: o?.status === 'done' ? 'done' : 'pending',
      }))
      .filter((o) => o.id > 0 && o.login && o.service);
    this._nextId = this.orders.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    this._dirty = false;
  }

  // ---------------- услуги ----------------

  _loginOf(login) { return String(login || '').toLowerCase().replace(/^@/, ''); }

  /** Услуги, доступные к покупке (для списка в чате). */
  catalog() {
    return this.items
      .filter((it) => it.enabled !== false && it.stock >= 0)
      .map((it) => `${it.name} — ${it.price}${it.stock > 0 ? ` (осталось ${it.stock})` : ''}${it.text ? ` (${it.text})` : ''}`);
  }

  /** Пересохранить список услуг из панели (VALIDATE + id для новых). */
  updateItems(list = []) {
    if (!Array.isArray(list)) throw new Error('Список услуг не понятен');
    this.items = list
      .slice(0, MAX_ITEMS)
      .map((it, i) => normalizeItem(it, i))
      .filter((it) => it.name);
    this._dirty = true;
    this.saveNow();
    return this.items;
  }

  // ---------------- заказы ----------------

  /** Найти услугу по названию (включённую и не распроданную не проверяем — по месту). */
  findItem(name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    return this.items.find((it) => it.name === wanted) ?? null;
  }

  /**
   * Заказать услугу: проверяем запас и лимит ждущих заказов, списываем баллы,
   * уменьшаем запас и создаём заказ. Не хватило баллов — ничего не меняется.
   */
  order({ login, name = '', serviceName = '' }) {
    const key = this._loginOf(login);
    if (!key) return { error: 'не поняли, кто заказывает' };
    const wanted = String(serviceName || '').trim().toLowerCase();
    if (!wanted) {
      return { list: this.catalog() };
    }
    const item = this.items.find((it) => it.name === wanted && it.enabled !== false);
    if (!item) return { error: `«${wanted.replace(/^!/, '')}» нет в магазине услуг` };
    if (item.stock < 0) return { error: `«${item.name}» распродано — выбери другое` };
    const pending = this.orders.filter((o) => o.status === 'pending' && o.login === key).length;
    if (pending >= MAX_PENDING_PER_USER) {
      return { error: `у тебя уже ${MAX_PENDING_PER_USER} ждущих заказов — дождись выполнения` };
    }
    const price = item.price;
    if (price > 0 && !this.points?.spend(key, price)) {
      return { error: `нужно ${price} балл(ов), а у тебя меньше` };
    }
    if (item.stock > 0) {
      item.stock -= 1;
      if (item.stock === 0) item.stock = -1; // 0 означал бы «бесконечно» — помечаем распродано
    }
    const order = {
      id: this._nextId++,
      login: key,
      name: String(name || '').trim().slice(0, 40),
      service: item.name,
      price,
      at: Date.now(),
      status: 'pending',
    };
    this.orders.push(order);
    this._dirty = true;
    this.saveNow();
    this.logs?.events?.push?.({ kind: 'заказ', text: `${order.name || key} заказал(а) «${item.name}» за ${price}` });
    this.logs?.system?.push?.({ level: 'info', message: `Заказ #${order.id}: @${key} купил(а) «${item.name}» за ${price} балл(ов)` });
    return { order, price, stockLeft: item.stock };
  }

  /** Ждущие выполнения заказы (для панели и !заказы). */
  pending() {
    return this.orders.filter((o) => o.status === 'pending');
  }

  /**
   * Подтверждение из панели: op 'done' — выполнено (уходит из ждущих, остаётся в истории),
   * op 'refund' — возврат баллов покупателю, заказ убирается совсем.
   */
  settle({ id, op }) {
    const oid = Number(id);
    if (!Number.isInteger(oid) || oid <= 0) return { error: 'номер заказа не понятен' };
    const idx = this.orders.findIndex((o) => o.id === oid && o.status === 'pending');
    if (idx < 0) return { error: 'заказ не найден — уже выполнен или возвращён' };
    const order = this.orders[idx];
    if (op === 'done') {
      order.status = 'done';
      // история не растёт вечно: держим последние KEEP_DONE выполненных
      const done = this.orders.filter((o) => o.status === 'done');
      if (done.length > KEEP_DONE) {
        const drop = new Set(done.slice(0, done.length - KEEP_DONE).map((o) => o.id));
        this.orders = this.orders.filter((o) => !(o.status === 'done' && drop.has(o.id)));
      }
      this.logs?.system?.push?.({ level: 'info', message: `Заказ #${order.id} («${order.service}», @${order.login}) выполнен ✅` });
    } else if (op === 'refund') {
      this.orders.splice(idx, 1);
      if (order.price > 0 && this.points) this.points.add(order.login, order.price);
      this.logs?.system?.push?.({ level: 'info', message: `Заказ #${order.id} («${order.service}», @${order.login}) отменён — возврат ${order.price} балл(ов)` });
    } else {
      return { error: 'неизвестное действие (нужно done или refund)' };
    }
    this._dirty = true;
    this.saveNow();
    return { order, op };
  }

  // ---------------- хранение ----------------

  saveNow() {
    if (!this._dirty) return;
    try {
      saveJson(this.dataFile, { items: this.items, orders: this.orders });
      this._dirty = false;
    } catch (e) {
      // критик: срыв записи не глотаем — панель должна видеть, _dirty остаётся на повтор
      this.logs?.system?.push?.({ level: 'error', message: `не записались услуги/заказы на диск: ${e?.message ?? e}` });
    }
  }

  stop() {
    this.saveNow();
  }
}

/** Нормализация одной услуги: имя ≤32, цена 0..1000000, запас -1..100000 (-1 = распродано). */
function normalizeItem(it, idx = 0) {
  const n = Number(it?.price);
  const s = Number(it?.stock);
  return {
    id: String(it?.id || `svc${Date.now().toString(36)}-${idx}`).slice(0, 40),
    name: String(it?.name || '').trim().toLowerCase().replace(/^!/, '').slice(0, 32),
    price: Number.isFinite(n) ? Math.max(0, Math.min(1_000_000, Math.round(n))) : 0,
    stock: Number.isFinite(s) ? Math.max(-1, Math.min(100_000, Math.floor(s))) : 0,
    enabled: it?.enabled !== false,
    text: String(it?.text || '').trim().slice(0, 200),
  };
}
