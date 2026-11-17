import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'src', 'public');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const MODULES_DIR = path.join(ROOT, 'modules');
export const MODULES_CONFIG_FILE = path.join(DATA_DIR, 'modules.json');
export const COMMANDS_FILE = path.join(DATA_DIR, 'commands.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
export const BROADCASTER_TOKENS_FILE = path.join(DATA_DIR, 'broadcaster-tokens.json');
export const SONGS_FILE = path.join(DATA_DIR, 'songs.json');
export const QUOTES_FILE = path.join(DATA_DIR, 'quotes.json');
export const WORDOFDAY_FILE = path.join(DATA_DIR, 'wordofday.json');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Атомарная запись: tmp-файл + rename (от повреждений при падении). */
export function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
