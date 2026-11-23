import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

/**
 * Настройки прокси хранятся в settings.proxy:
 *   { enabled, type: 'http'|'socks5'|'singbox'|'xray', url, socks*, core: {...} }
 * type='singbox'/'xray' — бот сам поднимает ядро локально (см. proxy-cores.js) и ходит
 * через его SOCKS5-вход на 127.0.0.1. Ядро не поднято/упало → запросы идут напрямую.
 */

/** Адрес локального ядра (подготавливается index.js при старте ядра): { host, port } | null. */
let coreAddress = null;
export function setCoreAddress(addr) { coreAddress = addr; }

/** Куда идёт запрос: { kind: 'http', url } | { kind: 'socks5', host, port, user, pass } | null. */
export function resolveRoute(proxy = {}) {
  if (!proxy || proxy?.enabled !== true) return null;
  const type = String(proxy.type || (proxy.url ? 'http' : '') || '');
  if (type === 'socks5') {
    if (!proxy.socksEnabled || !proxy.socksHost) return null;
    return { kind: 'socks5', host: String(proxy.socksHost), port: Math.max(1, Number(proxy.socksPort) || 1080), user: proxy.socksUser, pass: proxy.socksPass };
  }
  if (type === 'singbox' || type === 'xray') {
    if (!coreAddress) return null; // ядро не поднято — напрямую (стрим не должен страдать)
    return { kind: 'socks5', host: coreAddress.host, port: coreAddress.port, user: '', pass: '' };
  }
  if (proxy.url) return { kind: 'http', url: proxy.url };
  return null;
}

function parseProxyUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:') return { error: 'поддерживается только http-прокси (например http://127.0.0.1:8080)' };
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch {
    return { error: 'адрес прокси не понятен' };
  }
}

/** SOCKS5-хендшейк (RFC1928) → сокет, подключённый к target (без авторизации или user/pass). */
function socks5Connect({ host, port, user, pass }, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.once('timeout', () => fail(new Error('таймаут подключения к SOCKS5')));
    sock.once('error', fail);
    sock.once('connect', () => {
      const useAuth = Boolean(user);
      sock.write(useAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
      let stage = 'greeting';
      const onStep = (buf) => {
        if (stage === 'greeting') {
          if (buf.length < 2 || buf[0] !== 0x05) return fail(new Error('это не SOCKS5-сервер'));
          if (buf[1] === 0x02) { // сервер просит логин/пароль (RFC1929)
            const u = Buffer.from(String(user ?? ''), 'utf8');
            const p = Buffer.from(String(pass ?? ''), 'utf8');
            if (!u.length || u.length > 255 || p.length > 255) return fail(new Error('логин/пароль для SOCKS5 не подходят (≤255 байт)'));
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            stage = 'auth';
            return;
          }
          if (buf[1] !== 0x00) return fail(new Error('SOCKS5: сервер не поддерживает вход без пароля'));
          stage = 'connect';
          sendConnect();
          return;
        }
        if (stage === 'auth') {
          if (buf.length < 2 || buf[1] !== 0x00) return fail(new Error('SOCKS5: авторизация не прошла'));
          stage = 'connect';
          sendConnect();
          return;
        }
        // ответ на CONNECT
        if (buf.length < 4 || buf[0] !== 0x05) return fail(new Error('SOCKS5: кривой ответ'));
        if (buf[1] !== 0x00) return sock.destroy(), reject(new Error(`SOCKS5 отказал в соединении (код ${buf[1]})`));
        sock.removeListener('data', onStep);
        resolve(sock); // туннель готов
      };
      sock.on('data', onStep);
      function sendConnect() {
        const h = Buffer.from(target.hostname, 'utf8');
        if (h.length > 255) return fail(new Error('слишком длинное имя хоста'));
        const p = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(p >> 8) & 0xff, p & 0xff])]));
      }
    });
  });
}

/** Минимальный HTTP-клиент поверх уже подключённого сокета-туннеля (CONNECT/SOCKS5). */
function sendOverSocket(socket, targetUrl, { method = 'GET', timeoutMs = 12_000, headers = {}, body } = {}) {
  const target = new URL(targetUrl);
  const isTls = target.protocol === 'https:';
  const port = Number(target.port) || (isTls ? 443 : 80);
  return new Promise((resolve, reject) => {
    const finish = (err, resp) => {
      socket.destroy();
      err ? reject(err) : resolve(resp);
    };
    const send = (sock) => {
      const lib = isTls ? https : http;
      const r = lib.request({
        createConnection: () => sock,
        host: target.hostname,
        servername: target.hostname,
        method,
        path: `${target.pathname}${target.search}`,
        headers: {
          Host: target.host,
          'User-Agent': 'Mozilla/5.0 (local-twitch-bot)',
          ...headers,
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(String(body)) } : {}),
        },
        timeout: timeoutMs,
      }, (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => finish(null, { status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('timeout', () => { r.destroy(new Error('таймаут запроса')); });
      r.on('error', finish);
      r.end(body === undefined ? undefined : String(body));
    };
    if (isTls) {
      const ts = tls.connect({ socket, servername: target.hostname }, () => send(ts));
      ts.on('error', finish);
    } else {
      send(socket);
    }
  });
}

/** Минимальный HTTP-клиент через HTTP-прокси (CONNECT + TLS) на чистых модулях Node. */
function requestViaProxy(proxyUrl, targetUrl, opts = {}) {
  const p = parseProxyUrl(proxyUrl);
  if (p.error) return Promise.reject(new Error(p.error));
  const target = new URL(targetUrl);
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: p.host,
      port: p.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      timeout: opts.timeoutMs ?? 12_000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`прокси отказал в туннеле (HTTP ${res.statusCode})`));
        return;
      }
      sendOverSocket(socket, targetUrl, opts).then(resolve, reject);
    });
    req.on('timeout', () => { req.destroy(new Error('таймаут подключения к прокси')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET-запрос: напрямую или через прокси из настроек.
 * Возвращает { status, body }. Прокси не настроен/выключен — идём напрямую.
 */
export async function httpGet(url, proxy = null) {
  return httpRequest(url, { proxy });
}

/**
 * Произвольный HTTP-запрос (GET/POST/...) — напрямую или через прокси из настроек.
 * body — строка или Buffer (объекты сериализует сам вызывающий).
 * Возвращает { status, body }. Прокси не настроен/выключен — идём напрямую.
 */
export async function httpRequest(url, { proxy = null, method = 'GET', headers = {}, body, timeoutMs = 12_000 } = {}) {
  const route = resolveRoute(proxy);
  if (route?.kind === 'socks5') {
    const target = new URL(url);
    const sock = await socks5Connect(route, target, timeoutMs);
    return sendOverSocket(sock, url, { method, timeoutMs, headers, body });
  }
  if (route?.kind === 'http') {
    return requestViaProxy(route.url, url, { method, timeoutMs, headers, body });
  }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (local-twitch-bot)',
        ...headers,
        ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(String(body)) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('таймаут запроса')); });
    req.on('error', reject);
    req.end(body === undefined ? undefined : String(body));
  });
}

/** Проверка прокси: ходим через него за oEmbed известного ролика. */
export async function proxyCheck(proxy) {
  const r = await httpGet('https://www.youtube.com/oembed?url=https%3A//youtu.be/dQw4w9WgXcQ&format=json', proxy);
  try {
    const j = JSON.parse(r.body);
    if (j && j.title) return { ok: true, title: j.title };
  } catch {}
  throw new Error(`прокси ответил неожиданно (HTTP ${r.status})`);
}
