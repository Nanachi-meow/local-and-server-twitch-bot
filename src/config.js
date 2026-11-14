import fs from 'node:fs';
import { CONFIG_FILE, saveJson } from './store.js';

/** Каналы: принимает строку, строку через запятую или массив. Чистит, нижний регистр, максимум 10. */
export function normalizeChannels(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(',');
  return [
    ...new Set(
      list
        .map((s) => String(s).trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

export function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  // поддержка старого формата (один channel) — переезжает в список
  const channels = normalizeChannels(raw.channels ?? raw.channel ?? []);
  return {
    port: Number(raw.port) || 8080,
    channels,
    clientId: String(raw.clientId || '').trim(),
    clientSecret: String(raw.clientSecret || '').trim(),
  };
}

export function saveConfig(patch = {}) {
  const before = loadConfig();
  const next = {
    port: before.port,
    channels: before.channels,
    clientId: before.clientId,
    clientSecret: before.clientSecret,
  };
  if (patch.port !== undefined) next.port = Number(patch.port) || before.port;
  if (patch.channels !== undefined) next.channels = normalizeChannels(patch.channels);
  else if (patch.channel !== undefined) next.channels = normalizeChannels(patch.channel);
  if (patch.clientId !== undefined) next.clientId = String(patch.clientId).trim();
  if (patch.clientSecret !== undefined) next.clientSecret = String(patch.clientSecret).trim();
  // пишем только новый формат (список каналов)
  saveJson(CONFIG_FILE, next);
  return next;
}

export function isConfigured(config) {
  return Boolean(config.clientId && config.clientSecret && config.channels?.length);
}

export function effectivePort(config) {
  return Number(process.env.BOT_PORT) || config.port || 8080;
}
