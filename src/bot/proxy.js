import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';

/** Настройка прокси хранится в settings.proxy: { enabled, url } (например http://127.0.0.1:8080). */

function parseProxyUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:') return { error: 'поддерживается только http-прокси (например http://127.0.0.1:8080)' };
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch {
    return { error: 'адрес прокси не понятен' };
  }
}

/** Минимальный HTTP-клиент через прокси (CONNECT + TLS) на чистых модулях Node. */
function requestViaProxy(proxyUrl, targetUrl, { method = 'GET', timeoutMs = 12_000, headers = {}, body } = {}) {
  const p = parseProxyUrl(proxyUrl);
  if (p.error) return Promise.reject(new Error(p.error));
  const target = new URL(targetUrl);
  const isTls = target.protocol === 'https:';
  const port = Number(target.port) || (isTls ? 443 : 80);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: p.host,
      port: p.port,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`прокси отказал в туннеле (HTTP ${res.statusCode})`));
        return;
      }
      const finish = (err, body) => {
        socket.destroy();
        err ? reject(err) : resolve(body);
      };
      const send = (sock) => {
        const lib = isTls ? https : http;
        const r = lib.request({
          createConnection: () => sock,
          host: target.hostname,
          servername: target.hostname,
          method,
          path: target.pathname + target.search,
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
  if (proxy?.enabled && proxy?.url) {
    return requestViaProxy(proxy.url, url, { method, timeoutMs, headers, body });
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
