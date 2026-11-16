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
  '/music': { file: 'music.html', type: 'text/html; charset=utf-8' },
  '/sr-player.js': { file: 'sr-player.js', type: 'text/javascript; charset=utf-8' },
};

/** Папка с медиа-файлами для алертов (звуки/картинки). Файлы отдаются на /media/<имя>. */
const MEDIA_DIR = path.join(ROOT, 'overlay-media');
const MEDIA_EXT = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif',
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
      else throw new Error(`Неизвестное действие: ${op || '(пусто)'}`);
      sendJson(res, 200, r);
      return;
    }

    if (route === '/api/points' && req.method === 'GET') {
      sendJson(res, 200, { top: app.points.top(20), settings: app.settings.points });
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

    // ---------- тотализатор (карточка на вкладке «Баллы»): первый канал бота ----------
    if (route === '/api/bets' && req.method === 'GET') {
      const channelId = app.state.broadcasterId;
      const status = app.bets.status(channelId);
      const pool = app.bets.active(channelId);
      const top = [];
      if (pool) {
        pool.options.forEach((o, i) => {
          for (const b of o.bets) {
            top.push({ login: b.login, name: b.name || b.login, amount: b.amount, option: o.label, optionIndex: i + 1 });
          }
        });
        top.sort((a, b) => b.amount - a.amount);
      }
      sendJson(res, 200, { status, top: top.slice(0, 5), cfg: app.bets.cfg() });
      return;
    }

    if (route === '/api/services' && req.method === 'GET') {
      sendJson(res, 200, { items: app.services.items, orders: app.services.pending() });
      return;
    }

    if (route === '/api/services' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      try {
        const saved = app.saveServices(body);
        sendJson(res, 200, { ok: true, ...saved });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
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

    if (route === '/api/followage' && req.method === 'GET') {
      const user = u.searchParams.get('user') || '';
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
