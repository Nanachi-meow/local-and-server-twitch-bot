import { loadJson, saveJson } from '../store.js';
import { QUOTES_FILE } from '../store.js';

/**
 * Цитаты канала: массив { id, text, by, at } в data/quotes.json.
 * Номера автоинкрементные и не переиспользуются после удаления.
 * Без таймеров и start(): правки редки, поэтому сохраняются сразу
 * (флаг _dirty + saveNow по образцу points.js, но write-through).
 */
export class QuotesManager {
  constructor({ dataFile = QUOTES_FILE } = {}) {
    this.dataFile = dataFile;
    const stored = loadJson(this.dataFile, []);
    this.store = (Array.isArray(stored) ? stored : [])
      .map((q) => ({
        id: Math.floor(Number(q?.id) || 0),
        text: String(q?.text || '').trim().slice(0, 300),
        by: String(q?.by || '').toLowerCase().replace(/^@/, ''),
        at: Math.floor(Number(q?.at) || 0),
      }))
      .filter((q) => q.id > 0 && q.text);
    this._nextId = this.store.reduce((m, q) => Math.max(m, q.id), 0) + 1;
    this._dirty = false;
  }

  /** Добавить цитату (текст до 300 символов). Возвращает запись или null для пустого текста. */
  add(login, text) {
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return null;
    const item = {
      id: this._nextId++,
      text: t,
      by: String(login || '').toLowerCase().replace(/^@/, ''),
      at: Date.now(),
    };
    this.store.push(item);
    this._dirty = true;
    this.saveNow(); // автосейв без таймеров: пишем сразу
    return item;
  }

  /** Случайная цитата или null, если хранилище пустое. */
  random() {
    if (!this.store.length) return null;
    return this.store[Math.floor(Math.random() * this.store.length)];
  }

  byId(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    return this.store.find((q) => q.id === n) ?? null;
  }

  /** Поиск по подстроке без учёта регистра, не больше 5 результатов. */
  search(q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    return this.store.filter((item) => item.text.toLowerCase().includes(needle)).slice(0, 5);
  }

  /** Удалить по номеру: возвращает удалённую запись или null. */
  remove(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    const idx = this.store.findIndex((item) => item.id === n);
    if (idx < 0) return null;
    const [removed] = this.store.splice(idx, 1);
    this._dirty = true;
    this.saveNow();
    return removed;
  }

  /** Список для панели: по возрастанию номера, курсор afterId, лимит. */
  list({ limit = 50, afterId = 0 } = {}) {
    const after = Math.floor(Number(afterId)) || 0;
    const n = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 50));
    return this.store.filter((item) => item.id > after).slice(0, n);
  }

  saveNow() {
    if (!this._dirty) return;
    try {
      saveJson(this.dataFile, this.store);
      this._dirty = false;
    } catch {}
  }

  stop() {
    this.saveNow();
  }
}
