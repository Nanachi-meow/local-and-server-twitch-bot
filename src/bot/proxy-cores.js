/**
 * 🔌 Ядра прокси: sing-box и Xray-core — способы подключения бота к внешним прокси-протоколам
 * (vmess / vless / trojan / shadowsocks), включаяпарсинг URL-подписок.
 *
 * Как это работает (и почему это действует ТОЛЬКО на бота):
 *   бот запускает ядро как локальный процесс с конфигом, где вход — SOCKS5 на 127.0.0.1,
 *   выход — узел из подписки/ссылки. Никакого TUN и системного прокси: через ядро ходит
 *   исключительно трафик бота (музыка/YouTube, api.fetch модулей), бот сам стучится на
 *   127.0.0.1:порт. Падение/выключение ядра = бот идёт напрямую, стрим не страдает.
 *
 * Подписки: тело может быть plain-списком ссылок (vmess://…) или base64 всего тела —
 * поддерживаются vmess://, vless:// (в т.ч. reality), trojan://, ss://.
 * Формат конфигов: sing-box 1.x, Xray-core 1.x (v2fly-совместимый JSON).
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../store.js';

const CORE_CONFIG_FILE = path.join(DATA_DIR, 'proxy-core.json');

// ---------- парсинг ссылок ----------

function b64decode(s) {
  try { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return ''; }
}

/** vmess://BASE64({v,ps,add,port,id,aid,scy,net,type,host,path,tls,sni,fp}) → унифиц. описание узла. */
function parseVmess(link) {
  const j = JSON.parse(b64decode(link.slice('vmess://'.length)));
  if (!j?.add || !j?.id) return null;
  return {
    proto: 'vmess', name: String(j.ps ?? '').slice(0, 80),
    server: String(j.add), port: Math.max(1, Math.min(65535, Number(j.port) || 443)),
    uuid: String(j.id).slice(0, 64), alterId: Math.max(0, Number(j.aid) || 0), security: String(j.scy || 'auto'),
    transport: ['tcp', 'ws', 'grpc'].includes(j.net) ? String(j.net) : 'tcp',
    wsPath: String(j.path || '/').slice(0, 200), wsHost: String(j.host || '').slice(0, 200),
    tls: String(j.tls || '') === 'tls', sni: String(j.sni || j.host || '').slice(0, 200),
    fingerprint: String(j.fp || 'chrome').slice(0, 40),
  };
}

/** vless://uuid@host:port?encryption=none&security=tls|reality&sni=&pbk=&sid=&fp=&type=ws|tcp&path=&host=#имя */
function parseVless(link) {
  const u = new URL(link);
  if (!u.username || !u.hostname) return null;
  const q = u.searchParams;
  const security = q.get('security') || 'none';
  return {
    proto: 'vless', name: decodeURIComponent(u.hash.slice(1) || '').slice(0, 80),
    server: u.hostname, port: Number(u.port) || 443,
    uuid: decodeURIComponent(u.username).slice(0, 64),
    transport: ['tcp', 'ws', 'grpc'].includes(q.get('type')) ? q.get('type') : 'tcp',
    wsPath: (q.get('path') || '/').slice(0, 200), wsHost: (q.get('host') || '').slice(0, 200),
    tls: security === 'tls' || security === 'reality', sni: (q.get('sni') || q.get('host') || '').slice(0, 200),
    reality: security === 'reality' ? { publicKey: (q.get('pbk') || '').slice(0, 200), shortId: (q.get('sid') || '').slice(0, 64) } : null,
    fingerprint: (q.get('fp') || 'chrome').slice(0, 40), flow: (q.get('flow') || '').slice(0, 64),
  };
}

/** trojan://password@host:port?security=tls&sni=&type=ws&path=#имя */
function parseTrojan(link) {
  const u = new URL(link);
  if (!u.username || !u.hostname) return null;
  const q = u.searchParams;
  return {
    proto: 'trojan', name: decodeURIComponent(u.hash.slice(1) || '').slice(0, 80),
    server: u.hostname, port: Number(u.port) || 443,
    password: decodeURIComponent(u.username).slice(0, 128),
    transport: q.get('type') === 'ws' ? 'ws' : 'tcp',
    wsPath: (q.get('path') || '/').slice(0, 200), wsHost: (q.get('host') || '').slice(0, 200),
    tls: (q.get('security') || 'tls') !== 'none', sni: (q.get('sni') || '').slice(0, 200),
  };
}

/** ss://... — два формата: ss://BASE64(метод:пароль)@host:port#имя и ss://BASE64(метод:пароль@host:порт) */
function parseSS(link) {
  let body = String(link).slice('ss://'.length);
  // имя узла (#фрагмент) отрезаем ДО разбора хоста — иначе не матчится «хост:порт»
  let name = '';
  const hashAt = body.indexOf('#');
  if (hashAt >= 0) {
    name = decodeURIComponent(body.slice(hashAt + 1));
    body = body.slice(0, hashAt);
  }
  const at = body.lastIndexOf('@');
  let method = '', password = '', server = '', port = 443;
  if (at > 0) {
    // формат А: [метод:пароль | base64(метод:пароль)]@хост:порт
    const credPart = body.slice(0, at);
    const cred = b64decode(credPart).includes(':') && !credPart.includes(':') ? b64decode(credPart) : credPart;
    const m = String(cred).match(/^([^:]+):(.+)$/);
    if (!m) return null;
    method = m[1]; password = m[2];
    const hostPart = body.slice(at + 1);
    const hp = hostPart.match(/^([^\s:]+):(\d+)$/);
    if (!hp) return null;
    server = hp[1]; port = Number(hp[2]) || 443;
  } else {
    // формат Б: всё в base64 — метод:пароль@хост:порт
    const full = b64decode(body);
    const fp = full.match(/^([^:]+):(.+)@(.+):(\d+)$/);
    if (!fp) return null;
    method = fp[1]; password = fp[2]; server = fp[3]; port = Number(fp[4]) || 443;
  }
  if (!method || !server) return null;
  return { proto: 'ss', name: name.slice(0, 80), server, port, method: method.slice(0, 40), password: password.slice(0, 128) };
}

function b64HasPadding(s) { return /^[A-Za-z0-9+/\-_]+={0,2}$/.test(s) && s.length >= 8; }

/** Любая строка-ссылка → унифицированное описание узла (или null). */
export function parseProxyLink(link) {
  const s = String(link || '').trim();
  if (s.startsWith('vmess://')) { try { return parseVmess(s); } catch { return null; } }
  if (s.startsWith('vless://')) { try { return parseVless(s); } catch { return null; } }
  if (s.startsWith('trojan://')) { try { return parseTrojan(s); } catch { return null; } }
  if (s.startsWith('ss://')) { try { return parseSS(s); } catch { return null; } }
  return null;
}

/** Тело подписки (plain или base64) → список { node, raw } валидных узлов. */
export function parseSubscription(body) {
  const raw = String(body ?? '').trim();
  if (!raw) return [];
  let lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // тело целиком в base64 — декодируем (подписки часто так отдаются)
  if (lines.length <= 2 && b64HasPadding(raw.replace(/\s+/g, ''))) {
    const dec = b64decode(raw.replace(/\s+/g, ''));
    if (/(vmess|vless|trojan|ss):\/\//.test(dec)) lines = dec.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const out = [];
  for (const line of lines) {
    const node = parseProxyLink(line);
    if (node) out.push({ node, raw: line });
  }
  return out;
}

// ---------- генерация конфигов ----------

/** Описание узла → outbound sing-box 1.x. */
export function genSingboxOutbound(node) {
  const tls = node.tls
    ? {
        enabled: true,
        server_name: node.sni || undefined,
        utls: { enabled: true, fingerprint: node.fingerprint || 'chrome' },
        ...(node.reality ? { reality: { enabled: true, public_key: node.reality.publicKey, short_id: node.reality.shortId } } : {}),
      }
    : undefined;
  const transport =
    node.transport === 'ws'
      ? { type: 'ws', path: node.wsPath || '/', ...(node.wsHost ? { headers: { Host: node.wsHost } } : {}) }
      : undefined;
  if (node.proto === 'vmess') {
    return {
      type: 'vmess', server: node.server, server_port: node.port,
      uuid: node.uuid, security: node.security || 'auto', alter_id: node.alterId || 0,
      ...(tls ? { tls } : {}), ...(transport ? { transport } : {}),
    };
  }
  if (node.proto === 'vless') {
    return {
      type: 'vless', server: node.server, server_port: node.port,
      uuid: node.uuid,
      ...(node.flow ? { flow: node.flow } : {}),
      ...(tls ? { tls } : {}), ...(transport ? { transport } : {}),
    };
  }
  if (node.proto === 'trojan') {
    return {
      type: 'trojan', server: node.server, server_port: node.port,
      password: node.password,
      ...(tls ? { tls } : {}), ...(transport ? { transport } : {}),
    };
  }
  // ss
  return { type: 'shadowsocks', server: node.server, server_port: node.port, method: node.method, password: node.password };
}

/** Полный конфиг sing-box: вход SOCKS5 на 127.0.0.1, выход — узел, обмен — через direct. */
export function genSingboxConfig(node, listenPort) {
  return {
    log: { level: 'warn' },
    inbounds: [{ type: 'socks', tag: 'in', listen: '127.0.0.1', listen_port: listenPort }],
    outbounds: [genSingboxOutbound(node), { type: 'direct', tag: 'direct' }],
    route: { rules: [{ inbound: ['in'], outbound: 'proxy' }] },
  };
}

/** Описание узла → outbound + streamSettings Xray-core 1.x. */
export function genXrayOutbound(node) {
  const stream = { network: node.transport === 'ws' ? 'ws' : 'tcp' };
  if (node.tls) {
    stream.security = node.reality ? 'reality' : 'tls';
    if (node.reality) {
      stream.realitySettings = { serverName: node.sni || '', publicKey: node.reality.publicKey, shortId: node.reality.shortId, fingerprint: node.fingerprint || 'chrome' };
    } else {
      stream.tlsSettings = { serverName: node.sni || '', fingerprint: node.fingerprint || 'chrome' };
    }
  }
  if (node.transport === 'ws') stream.wsSettings = { path: node.wsPath || '/', ...(node.wsHost ? { headers: { Host: node.wsHost } } : {}) };

  if (node.proto === 'vmess') {
    return {
      protocol: 'vmess',
      settings: { vnext: [{ address: node.server, port: node.port, users: [{ id: node.uuid, alterId: node.alterId || 0, security: node.security || 'auto' }] }] },
      streamSettings: stream,
    };
  }
  if (node.proto === 'vless') {
    return {
      protocol: 'vless',
      settings: { vnext: [{ address: node.server, port: node.port, users: [{ id: node.uuid, encryption: 'none', ...(node.flow ? { flow: node.flow } : {}) }] }] },
      streamSettings: stream,
    };
  }
  if (node.proto === 'trojan') {
    return {
      protocol: 'trojan',
      settings: { servers: [{ address: node.server, port: node.port, password: node.password }] },
      streamSettings: stream,
    };
  }
  return {
    protocol: 'shadowsocks',
    settings: { servers: [{ address: node.server, port: node.port, method: node.method, password: node.password }] },
    streamSettings: stream,
  };
}

/** Полный конфиг Xray: SOCKS5-вход на 127.0.0.1, выход — узел. */
export function genXrayConfig(node, listenPort) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'in', listen: '127.0.0.1', port: listenPort, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [genXrayOutbound(node), { tag: 'direct', protocol: 'freedom' }],
    routing: { rules: [{ type: 'field', inboundTag: ['in'], outboundTag: 'proxy' }] },
  };
}

// ---------- раннер локального ядра ----------

/** Свободный TCP-порт (для входа SOCKS ядра). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export class CoreRunner {
  constructor({ logs } = {}) {
    this.logs = logs;
    this.proc = null;
    this.port = 0;
    this.node = null;        // текущий узел (описание)
    this.kind = null;        // 'singbox' | 'xray'
    this.binaryPath = null;
    this.restartTimer = null;
    this.stopping = false;
  }

  address() {
    // живой адрес для проксирования: { host, port } или null
    return this.proc && this.port ? { host: '127.0.0.1', port: this.port } : null;
  }

  /** Поднять ядро (или перезапустить с новым узлом). conf — {kind, binaryPath, link}. */
  async start({ kind, binaryPath, link }) {
    if (!['singbox', 'xray'].includes(kind)) throw new Error('неизвестное ядро прокси');
    const node = parseProxyLink(link);
    if (!node) throw new Error('ссылка узла не распознана (нужен vmess://, vless://, trojan:// или ss://)');
    if (!fs.existsSync(binaryPath)) throw new Error(`не найден файл ядра: ${binaryPath}`);
    await this.stop();
    this.kind = kind;
    this.binaryPath = binaryPath;
    this.node = node;
    this.port = Number(process.env.PROXY_CORE_PORT) || await freePort();
    const config = (kind === 'singbox' ? genSingboxConfig : genXrayConfig)(node, this.port);
    fs.writeFileSync(CORE_CONFIG_FILE, JSON.stringify(config), 'utf8');
    this._spawn();
    return { port: this.port, node };
  }

  _spawn() {
    this.stopping = false;
    const args = this.kind === 'singbox'
      ? ['run', '-c', CORE_CONFIG_FILE]
      : ['run', '-c', CORE_CONFIG_FILE];
    const p = spawn(this.binaryPath, args, { windowsHide: true });
    this.proc = p;
    let stderrBuf = '';
    p.stderr?.on('data', (d) => {
      if (stderrBuf.length < 2000) stderrBuf += d.toString();
      if (/error|fatal/i.test(stderrBuf) && !this.stopping) {
        this.logs?.system?.push?.({ level: 'error', message: `Ядро прокси (${this.kind}): ${stderrBuf.split('\n').filter(Boolean).at(-1)?.slice(0, 200)}` });
      }
    });
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      if (this.stopping || code === 0) return;
      // упал — перезапуск с бэкоффом; бот пока ходит напрямую
      this.logs?.system?.push?.({ level: 'warn', message: `Ядро прокси (${this.kind}) упало (код ${code}) — перезапуск через 5 сек` });
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.node) { try { this._spawn(); } catch {} }
      }, 5000);
    });
    if (this.logs) this.logs.system.push({ level: 'info', message: `Ядро прокси ${this.kind === 'singbox' ? 'sing-box' : 'Xray'} запущено: 127.0.0.1:${this.port} → ${this.node?.name || this.node?.server}` });
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const p = this.proc;
    this.proc = null;
    if (p) {
      p.kill();
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
