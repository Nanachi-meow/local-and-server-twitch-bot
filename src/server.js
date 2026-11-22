import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, ROOT } from './store.js';
import { overlay } from './bot/alerts.js';

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/overlay': { file: 'overlay.html', type: 'text/html; charset=utf-8' },
  '/sr-player.js': { file: 'sr-player.js', type: 'text/javascript; charset=utf-8' }, // надпись «сейчас играет» в оверлее
  '/editor-engine.js': { file: 'editor-engine.js', type: 'text/javascript; charset=utf-8' }, // движок редакторов раскладки (как у плеера музыки)
};

/** Папка кастомизируемого плеера музыки (страница /music) — см. player/README.md. */
const PLAYER_DIR = path.join(ROOT, 'player');
const PLAYER_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif',
};

/** Папка с медиа-файлами для алертов (звуки/картинки). Файлы отдаются на /media/<имя>. */
const MEDIA_DIR = path.join(ROOT, 'overlay-media');
const MEDIA_EXT = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.gif': 'image/gif', '.apng': 'image/apng', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

const ANNOUNCE_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'];

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function redirect(res, to) {
  send(res, 302, '', { Location: to });
}

async function readJsonBody(req, limit = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Тело запроса слишком большое');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Сырое тело (для проверки подписи webhook: HMAC считается от байтов как есть). */
async function readRawBody(req, limit = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Тело запроса слишком большое');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Локальный HTTP-сервер: раздаёт панель и JSON-API. Слушает только 127.0.0.1. */
export function createHttpServer({ app }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  });

  async function handle(req, res) {
    const u = new URL(req.url, `http://127.0.0.1:${app.port}`);
    const route = `${u.pathname}`;

    // ---------- статика ----------
    const st = STATIC[route];
    if (st && req.method === 'GET') {
      try {
        const body = fs.readFileSync(path.join(PUBLIC_DIR, st.file));
        send(res, 200, body, { 'Content-Type': st.type, 'Cache-Control': 'no-store' });
      } catch {
        send(res, 404, 'not found');
      }
      return;
    }

    // ---------- плеер музыки: всё из папки player/ (/music и /music/<файл>) ----------
    if (route === '/music' || route.startsWith('/music/')) {
      if (req.method !== 'GET') { send(res, 405, 'method not allowed'); return; }
      const rel = route === '/music' ? 'index.html' : path.basename(decodeURIComponent(route.slice('/music/'.length)));
      const type = PLAYER_TYPES[path.extname(rel).toLowerCase()];
      const full = path.join(PLAYER_DIR, rel);
      if (!type || !fs.existsSync(full)) { send(res, 404, 'not found'); return; }
      try {
        send(res, 200, fs.readFileSync(full), { 'Content-Type': type, 'Cache-Control': 'no-store' });
      } catch {
        send(res, 404, 'not found');
      }
      return;
    }

    // ---------- медиа-файлы алертов: /media/<имя> из папки overlay-media ----------
    if (route.startsWith('/media/') && req.method === 'GET') {
      const name = path.basename(decodeURIComponent(route.slice('/media/'.length)));
      const ext = path.extname(name).toLowerCase();
      const type = MEDIA_EXT[ext];
      const full = path.join(MEDIA_DIR, name);
      if (!type || !fs.existsSync(full)) {
        send(res, 404, 'not found');
        return;
      }
      try {
        const body = fs.readFileSync(full);
        send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      } catch {
        send(res, 404, 'not found');
      }
      return;
    }

    if (route === '/api/media' && req.method === 'GET') {
      let files = [];
      try {
        files = fs.readdirSync(MEDIA_DIR)
          .filter((f) => MEDIA_EXT[path.extname(f).toLowerCase()])
          .sort();
      } catch {}
      sendJson(res, 200, { files });
      return;
    }

    // ---------- файлы алертов: загрузка прямо из панели (overlay-media/) ----------
    if (route === '/api/media/upload' && req.method === 'POST') {
      const u2 = u.searchParams.get('name') || '';
      const name = path.basename(u2).slice(0, 120);
      const type = MEDIA_EXT[path.extname(name).toLowerCase()];
      if (!name || !type) {
        sendJson(res, 400, { error: 'Не знаю такой тип файла. Поддержка: mp3/wav/ogg/flac/m4a, mp4/webm/mov/m4v/ogv, gif/apng/png/webp/jpg/svg' });
        return;
      }
      // сырые байты; видео бывают тяжёлыми — лимит 64 МБ
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) { sendJson(res, 413, { error: 'Файл больше 64 МБ' }); return; }
        chunks.push(chunk);
      }
      if (!chunks.length) { sendJson(res, 400, { error: 'Пустой файл' }); return; }
      try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
      try {
        fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.concat(chunks));
        app.logs.system.push({ level: 'info', message: `Файл алертов загружен: ${name}` });
        sendJson(res, 200, { ok: true, name });
      } catch (e) {
        sendJson(res, 500, { error: `Не смогла записать файл: ${e.message}` });
      }
      return;
    }

    if (route === '/api/media' && req.method === 'DELETE') {
      const name = path.basename(u.searchParams.get('name') || '').slice(0, 120);
      const full = path.join(MEDIA_DIR, name);
      if (!name || !MEDIA_EXT[path.extname(name).toLowerCase()] || !fs.existsSync(full)) {
        sendJson(res, 404, { error: 'Нет такого файла' });
        return;
      }
      try {
        fs.unlinkSync(full);
        app.logs.system.push({ level: 'info', message: `Файл алертов удалён: ${name}` });
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 500, { error: 'Не смогла удалить файл' });
      }
      return;
    }

    // ---------- оверлей: поток событий (SSE) ----------
    if (route === '/overlay/feed' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      overlay.clients.add(res);
      res.write(': welcome\n\n');
      const keep = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 25_000);
      req.on('close', () => {
        clearInterval(keep);
        overlay.clients.delete(res);
      });
      return;
    }

    // ---------- OAuth ----------
    if (route === '/auth/bot' && req.method === 'GET') {
      if (!app.isConfigured()) {
        redirect(res, '/#err:' + encodeURIComponent('Сначала заполни настройки приложения'));
        return;
      }
      redirect(res, app.auth.beginAuth(app.port));
      return;
    }

    if (route === '/auth/callback' && req.method === 'GET') {
      const error = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (error) {
        redirect(res, '/#err:' + encodeURIComponent(error));
        return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (!code || !app.auth.checkState(state)) {
        redirect(res, '/#err:' + encodeURIComponent('Неверный state — начни вход заново'));
        return;
      }
      try {
        await app.auth.exchangeCode(code, app.port);
        app.logSystem(`Вход выполнен: ${app.auth.tokens.login}`, 'info');
        await app.startRuntime();
        redirect(res, '/#ok');
      } catch (e) {
        app.logSystem(`Ошибка входа: ${e.message}`, 'error');
        redirect(res, '/#err:' + encodeURIComponent(e.message));
      }
      return;
    }

    // ---------- OAuth «Вход как стример» (награды канала) ----------
    if (route === '/auth/broadcaster' && req.method === 'GET') {
      if (!app.isConfigured()) {
        redirect(res, '/#err:' + encodeURIComponent('Сначала заполни настройки приложения'));
        return;
      }
      redirect(res, app.broadcaster.beginAuth(app.port));
      return;
    }

    if (route === '/auth/broadcaster/callback' && req.method === 'GET') {
      const error = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (error) {
        redirect(res, '/#err:' + encodeURIComponent(error));
        return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (!code || !app.broadcaster.checkState(state)) {
        redirect(res, '/#err:' + encodeURIComponent('Неверный state — начни вход стримера заново'));
        return;
      }
      try {
        await app.broadcaster.exchangeCode(code, app.port);
        app.logSystem(`Вход как стример выполнен: ${app.broadcaster.tokens.login}`, 'info');
        if (app.state.running) await app.stopRuntime(); // пересобрать подписки: + награды канала
        await app.startRuntime();
        redirect(res, '/#ok:broadcaster');
      } catch (e) {
        app.logSystem(`Ошибка входа стримера: ${e.message}`, 'error');
        redirect(res, '/#err:' + encodeURIComponent(e.message));
      }
      return;
    }

    // ---------- API ----------
    if (route === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, app.apiState());
      return;
    }

    if (route === '/api/logs' && req.method === 'GET') {
      const chatAfter = Number(u.searchParams.get('chat') || 0) || 0;
      const eventsAfter = Number(u.searchParams.get('events') || 0) || 0;
      const systemAfter = Number(u.searchParams.get('system') || 0) || 0;
      sendJson(res, 200, {
        chat: app.logs.chat.since(chatAfter).slice(-100),
        events: app.logs.events.since(eventsAfter).slice(-100),
        system: app.logs.system.since(systemAfter).slice(-100),
      });
      return;
    }

    if (route === '/api/settings' && req.method === 'GET') {
      sendJson(res, 200, app.settings);
      return;
    }

    if (route === '/api/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      app.saveSettings(body);
      sendJson(res, 200, app.settings);
      return;
    }

    if (route === '/api/commands' && req.method === 'GET') {
      sendJson(res, 200, { custom: app.commands.list(), builtins: app.commands.builtinInfo() });
      return;
    }

    if (route === '/api/commands' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const saved = app.commands.upsert(body);
      sendJson(res, 200, { ok: true, command: saved });
      return;
    }

    if (route === '/api/commands' && req.method === 'DELETE') {
      const name = u.searchParams.get('name') || '';
      const removed = app.commands.remove(name);
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    if (route === '/api/wordofday' && req.method === 'GET') {
      sendJson(res, 200, { wod: app.processor.wodState() });
      return;
    }

    if (route === '/api/songs' && req.method === 'GET') {
      sendJson(res, 200, app.songs.state());
      return;
    }

    if (route === '/api/songs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const op = String(body?.op || '');
      // 'ended' и 'hello' звнит плеер с /music; остальное — панель
      let r;
      if (op === 'ended') r = app.songs.ended();
      else if (op === 'remove') r = app.songs.removeAt(body.index);
      else if (op === 'hello') r = { ok: true };
      else if (op === 'test') r = app.songs.test();
      else if (op === 'blacklist-add') {
        r = await app.songs.blacklistAdd(String(body?.url || ''));
        if (!r.error) app.saveSettings({}); // ЧС живёт в настройках — фиксируем на диск
      }
      else if (op === 'blacklist-remove') {
        r = app.songs.blacklistRemove(String(body?.id || ''));
        if (!r.error) app.saveSettings({});
      }
      else throw new Error(`Неизвестное действие: ${op || '(пусто)'}`);
      sendJson(res, 200, r);
      return;
    }

    // сброс входа стримера (карточка «👑 Награды канала»)
    if (route === '/api/broadcaster/logout' && req.method === 'POST') {
      try {
        await app.broadcasterLogout();
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: app.humanizeError(e) });
      }
      return;
    }

    // ---------- цитаты (карточка на вкладке «Команды») ----------
    if (route === '/api/quotes' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(500, Number(u.searchParams.get('limit')) || 100));
      sendJson(res, 200, { quotes: app.quotes.list({ limit }) });
      return;
    }

    if (route === '/api/quotes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body?.text || '').trim();
      if (!text) {
        sendJson(res, 400, { error: 'Пустой текст цитаты' });
        return;
      }
      sendJson(res, 200, { ok: true, quote: app.quotes.add('Панель', text) });
      return;
    }

    if (route === '/api/quotes' && req.method === 'DELETE') {
      const removed = app.quotes.remove(Number(u.searchParams.get('id')));
      if (!removed) {
        sendJson(res, 404, { error: 'Цитаты с таким номером нет' });
        return;
      }
      sendJson(res, 200, { ok: true, removed });
      return;
    }

    if (route === '/api/modules' && req.method === 'GET') {
      sendJson(res, 200, { modules: app.modules.list() });
      return;
    }

    if (route === '/api/modules' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const name = String(body?.name || '');
      if (!name) {
        sendJson(res, 400, { error: 'Укажи имя модуля' });
        return;
      }
      if (body?.settings && typeof body.settings === 'object') {
        app.modules.updateSettings(name, body.settings);
      }
      if (body?.enabled !== undefined) {
        app.modules.setEnabled(name, body.enabled !== false);
      }
      sendJson(res, 200, { ok: true, modules: app.modules.list() });
      return;
    }

    if (route === '/api/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      await app.onConfigSaved(body);
      sendJson(res, 200, { ok: true, state: app.apiState() });
      return;
    }

    if (route === '/api/logout' && req.method === 'POST') {
      await app.stopRuntime();
      app.auth.logout();
      app.logSystem('Токены сброшены — войдите заново', 'warn');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === '/api/pinned' && req.method === 'GET') {
      sendJson(res, 200, { pinned: await app.getPinned(u.searchParams.get('channel')) });
      return;
    }

    if (route.startsWith('/api/actions/') && req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = route.slice('/api/actions/'.length);
      try {
        const result = await app.runAction(action, body);
        sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        sendJson(res, e.status || 400, { error: app.humanizeError(e) });
      }
      return;
    }

    // webhook донатов таймера: HMAC-SHA256 подпись проверяется в donatimer.js
    // (секрет из настроек donations[source].webhookSecret; ?source=donatex|da|donatepay)
    if (route === '/api/webhooks/donations' && req.method === 'POST') {
      const source = String(u.searchParams.get('source') || 'donatex');
      const signature = String(req.headers['x-hub-signature'] || req.headers['x-donatex-signature'] || req.headers['x-signature'] || '');
      const raw = await readRawBody(req);
      try {
        const result = await app.donaTimer.handleWebhook({ source, rawBody: raw, signature });
        const status = result?.error === 'bad signature' ? 401 : (result?.error === 'timer disabled' ? 403 : 200);
        sendJson(res, status, result);
      } catch (e) {
        sendJson(res, 400, { error: app.humanizeError(e) });
      }
      return;
    }

    if (route === '/api/followage' && req.method === 'GET') {      const user = u.searchParams.get('user') || '';
      try {
        const result = await app.followage(user, u.searchParams.get('channel'));
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 400, { error: app.humanizeError(e) });
      }
      return;
    }

    sendJson(res, 404, { error: 'Не найдено' });
  }

  return server;
}
