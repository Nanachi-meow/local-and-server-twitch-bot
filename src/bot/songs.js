import { loadJson, saveJson } from '../store.js';
import { SONGS_FILE } from '../store.js';
import { overlay } from './alerts.js';
import { httpGet } from './proxy.js';

const VID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Вытащить ID видео из любых ссылок YouTube (youtu.be, watch?v=, shorts, music, live, голый ID). */
export function parseVideoId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (VID_RE.test(raw)) return raw;
  const m = raw
    .match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchVideoInfo(videoId, proxy, fetcher = httpGet) {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://youtu.be/${videoId}`)}&format=json`;
  const r = await fetcher(oembed, proxy);
  if (r.status !== 200) {
    throw new Error(r.status === 401 || r.status === 403 || r.status === 404 ? 'видео не найдено или недоступно' : `YouTube ответил HTTP ${r.status}`);
  }
  let title = '';
  let author = '';
  try {
    const j = JSON.parse(r.body);
    title = j.title || '';
    author = j.author_name || '';
  } catch { throw new Error('YouTube прислал неожиданный ответ'); }

  // длина — со страницы просмотра (лучшее усилие; без API-ключей)
  let duration = 0;
  try {
    const page = await fetcher(`https://www.youtube.com/watch?v=${videoId}&hl=ru`, proxy);
    const m = String(page.body || '').match(/"lengthSeconds"\s*:\s*"?(\d{1,6})/);
    if (m) duration = Number(m[1]);
  } catch {}
  return { title, author, duration };
}

/**
 * Очередь заказов музыки: хранение в data/songs.json, события в оверлей (kind 'sr'),
 * деньги/economy — на стороне команд (points), менеджер только про очередь.
 * Пушит события: op: 'update' (очередь/текущая изменилась), 'play', 'stop', 'pause', 'resume'.
 */
export class SongsManager {
  constructor({ logs, settings, dataFile = SONGS_FILE, fetcher = httpGet }) {
    this.logs = logs;
    this.settings = settings; // живой объект настроек (songs*, proxy*)
    this.dataFile = dataFile;
    this.fetcher = fetcher;
    const stored = loadJson(this.dataFile, null) ?? {};
    this.queue = Array.isArray(stored.queue) ? stored.queue : [];
    this.history = Array.isArray(stored.history) ? stored.history : [];
    this.current = stored.current ?? null;
    this.paused = Boolean(stored.paused);
    this._dirty = false;
  }

  cfg() {
    return this.settings?.songs ?? {};
  }

  saveNow() {
    try {
      saveJson(this.dataFile, {
        queue: this.queue,
        history: this.history.slice(-50),
        current: this.current,
        paused: this.paused,
      });
      this._dirty = false;
    } catch (e) {
      this.logs?.system?.push?.({ level: 'error', message: `не записалась очередь музыки на диск: ${e.message}` });
    }
  }

  _emit(op, extra = {}) {
    overlay.push({ kind: 'sr', op, ...this.state(), ...extra });
  }

  state() {
    return {
      current: this.current,
      queue: this.queue.slice(0, 20),
      paused: this.paused,
      enabled: Boolean(this.cfg().enabled),
      volume: this.cfg().volume ?? 60,
      nowTemplate: this.cfg().nowTemplate || '♪ {title} (заказ {by})',
    };
  }

  /** Добавить трек в очередь. Валидация длины/дублей/лимита — здесь, баллы — в команде. */
  async add({ videoId, by, byName }) {
    const cfg = this.cfg();
    if (!cfg.enabled) return { error: 'музыка выключена' };
    const id = String(videoId || '');
    const byLogin = String(by || '').toLowerCase();
    const maxLen = Math.max(0, Number(cfg.maxLenSec ?? 600));
    const perUser = Math.max(1, Number(cfg.perUser ?? 2));
    if (!id) return { error: 'не поняла ссылку — пришли ссылку на ролик YouTube' };
    if (!this.current && !this.queue.length) {
      // очередь пуста — этот трек станет текущим, лимиты на «текущий» не считаем
    } else {
      if (this.queue.some((x) => x.id === id) || this.current?.id === id) return { error: 'этот трек уже в очереди' };
      const mine = this.queue.filter((x) => String(x.by).toLowerCase() === byLogin).length;
      if (mine >= perUser) return { error: `у тебя уже ${mine} ${mine === 1 ? 'трек' : 'трека'} в очереди — дождись` };
    }
    let title = '';
    let author = '';
    let duration = 0;
    try {
      const info = await fetchVideoInfo(id, this.settings?.proxy, this.fetcher);
      title = info.title;
      author = info.author;
      duration = info.duration;
    } catch (e) {
      return { error: `не смогла узнать трек: ${e.message}` };
    }
    if (!title) return { error: 'не смогла узнать название — видео недоступно?' };
    if (maxLen && (!duration || duration > maxLen)) {
      return { error: !duration
        ? 'не смогла узнать длину видео — попробуй другое'
        : `слишком длинно (${duration} сек > лимита ${maxLen})` };
    }
    const song = { id, title, author, duration, by: byLogin, byName: byName || byLogin, at: Date.now() };
    if (!this.current) {
      this.current = song;
      this._emit('play');
    } else {
      this.queue.push(song);
      this._emit('update');
    }
    this._dirty = true;
    this.saveNow();
    return { song, position: this.current?.id === id ? 0 : this.queue.length };
  }

  /** Видео закончилось (сообщает плеер с /music). */
  ended() {
    if (!this.current) return { stopped: true };
    this.history.push(this.current);
    this._dirty = true;
    const next = this.queue.shift();
    this.current = next ?? null;
    this.saveNow();
    if (next) this._emit('play');
    else this._emit('stop');
    return { next: Boolean(next) };
  }

  skip() {
    if (!this.current) return { error: 'сейчас ничего не играет' };
    return this.ended();
  }

  clear() {
    this.queue = [];
    this._dirty = true;
    this.saveNow();
    this._emit('update');
    return { cleared: true };
  }

  control(op) {
    if (op === 'pause') {
      if (!this.current) return { error: 'нечего паузить' };
      this.paused = true;
      this._emit('pause');
    } else if (op === 'resume') {
      this.paused = false;
      this._emit('resume');
    } else if (op === 'stop') {
      this.current = null;
      this.queue = [];
      this.paused = false;
      this._dirty = true;
      this.saveNow();
      this._emit('stop');
    } else {
      return { error: `неизвестное действие: ${op}` };
    }
    this._dirty = true;
    this.saveNow();
    return { ok: true };
  }

  removeAt(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.queue.length) return { error: 'нет такого номера в очереди' };
    this.queue.splice(i, 1);
    this._dirty = true;
    this.saveNow();
    this._emit('update');
    return { ok: true };
  }
}
