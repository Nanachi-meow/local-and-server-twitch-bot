/* Панель управления: ванильный JS, поллинг раз в 2 секунды. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}ч ${m}м` : `${m}м ${s % 60}с`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${isError ? 'err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// Не даём опросу состояния затирать поля настроек, пока их заполняют
let settingsFormTouched = false;
['cfg-client-id', 'cfg-client-secret', 'cfg-port'].forEach((id) => {
  const el = document.getElementById(id);
  el?.addEventListener('input', () => { settingsFormTouched = true; });
});

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---------------- вкладки ----------------

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.tabpane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    // вкладка была скрыта — превью раскладки музыки рисовалось с нулевой шириной; перерисуем
    if (btn.dataset.tab === 'songs') requestAnimationFrame(() => { plpRenderStage(); plpRenderProps(); });
    if (btn.dataset.tab === 'autoso') requestAnimationFrame(() => { asoRenderStage(); asoRenderProps(); });
    if (btn.dataset.tab === 'overlay') requestAnimationFrame(() => { wodRenderStage(); wodRenderProps(); });
  });
});

// подвкладки внутри вкладки (Команды → Кастомные / Встроенные)
$$('.subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const pane = btn.closest('.tabpane');
    if (!pane) return;
    pane.querySelectorAll('.subtab').forEach((b) => b.classList.remove('active'));
    pane.querySelectorAll('[id^="sub-"]').forEach((d) => d.classList.add('hidden'));
    btn.classList.add('active');
    const target = pane.querySelector(`#sub-${btn.dataset.subtab}`);
    if (target) target.classList.remove('hidden');
  });
});
document.addEventListener('click', (e) => {
  const link = e.target.closest('.goto-tab');
  if (!link) return;
  e.preventDefault();
  const btn = $(`.tab[data-tab="${link.dataset.tab}"]`);
  if (btn) btn.click();
});

// ---------------- hash-баннеры ----------------

function handleHash() {
  const hash = decodeURIComponent(location.hash || '');
  if (!hash) return;
  const banner = $('#banner');
  if (hash.startsWith('#ok:broadcaster')) {
    banner.textContent = '✅ Стример залогинен — бот видит списания наград канала.';
    banner.className = 'banner ok';
  } else if (hash.startsWith('#ok')) {
    banner.textContent = '✅ Успех! Бот залогинен.';
    banner.className = 'banner ok';
  } else if (hash.startsWith('#err:')) {
    banner.textContent = `❌ ${hash.slice(5)}`;
    banner.className = 'banner err';
  }
  setTimeout(() => banner.classList.add('hidden'), 15000);
  history.replaceState(null, '', location.pathname);
}

// ---------------- логи ----------------

const lastIds = { chat: 0, events: 0, system: 0 };

function appendLog(container, html, isAtBottom) {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = html;
  container.appendChild(div);
  while (container.children.length > 250) container.removeChild(container.firstChild);
  if (isAtBottom) container.scrollTop = container.scrollHeight;
}

function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function renderLogs(data) {
  const chatEl = $('#log-chat');
  const chatBottom = atBottom(chatEl);
  for (const m of data.chat) {
    const lvl = m.level && m.level !== 'everyone' ? `<span class="lvl">(${esc(m.level)})</span>` : '';
    const ch = m.channel ? `<span class="ch">#${esc(m.channel)}</span>` : '';
    appendLog(chatEl, `<span class="time">${fmtTime(m.ts)}</span>${ch}<span class="who">${esc(m.user || m.login)}</span>${lvl}${esc(m.text)}`, chatBottom);
  }
  const evEl = $('#log-events');
  const evBottom = atBottom(evEl);
  for (const l of data.events) {
    const ch = l.channel ? ` <span class="ch">#${esc(l.channel)}</span>` : '';
    appendLog(evEl, `<span class="time">${fmtTime(l.ts)}</span><span class="kind">[${esc(l.kind)}]</span>${ch} ${esc(l.text)}`, evBottom);
  }
  // системные — в общую ленту событий, серым
  for (const l of data.system) {
    const cls = l.level === 'error' ? 'error' : '';
    appendLog(evEl, `<span class="time">${fmtTime(l.ts)}</span><span class="${cls}">⚙︎ ${esc(l.message)}</span>`, evBottom);
  }
  lastIds.chat = data.chat.length ? data.chat[data.chat.length - 1].id : lastIds.chat;
  lastIds.events = data.events.length ? data.events[data.events.length - 1].id : lastIds.events;
  lastIds.system = data.system.length ? data.system[data.system.length - 1].id : lastIds.system;
}

function renderChannelChips(list) {
  const el = $('#cfg-channels');
  if (!el) return;
  const key = list.join(',');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = list.length
    ? list.map((c) => `<span class="chip ok" data-login="${esc(c)}">#${esc(c)} <b class="ch-x" title="убрать канал">✕</b></span>`).join('')
    : '<span class="chip err">каналы не добавлены</span>';
}

async function saveChannels(newList, { allowEmpty = false } = {}) {
  if (!newList.length && !allowEmpty) { toast('Нужен хотя бы один канал', true); return false; }
  await api('/api/config', { method: 'POST', body: JSON.stringify({ channels: newList }) });
  toast('Каналы обновлены — бот перенастраивается ✅');
  return true;
}

$('#channel-add-btn').addEventListener('click', async () => {
  const input = $('#cfg-channel-add');
  const val = input.value.trim().replace(/^@/, '').toLowerCase();
  if (!val) return;
  const cur = (window.__state?.config?.channels ?? []).filter(Boolean);
  if (cur.includes(val)) { toast('Такой канал уже в списке', true); return; }
  if (cur.length >= 10) { toast('Максимум 10 каналов', true); return; }
  try {
    if (await saveChannels([...cur, val])) input.value = '';
  } catch (e) { toast(e.message, true); }
});

$('#cfg-channels').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip[data-login]');
  if (!chip) return;
  if (!confirm(`Убрать канал #${chip.dataset.login}?`)) return;
  const cur = (window.__state?.config?.channels ?? []).filter(Boolean);
  try { await saveChannels(cur.filter((c) => c !== chip.dataset.login)); } catch (err) { toast(err.message, true); }
});

function qaChannel() {
  const sel = $('#qa-channel');
  return sel && sel.value ? sel.value : undefined;
}

// ---------------- статус ----------------

function setChip(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `chip ${cls || ''}`;
}

let __botStartedAt = null; // время старта бота — для локального тика аптайма каждую секунду

// аптайм тикает сам каждую секунду (сервер опрашивается раз в 2с — без этого счётчик прыгал бы по 2)
setInterval(() => {
  const el = $('#st-uptime');
  if (el && __botStartedAt) el.textContent = fmtDuration(Date.now() - __botStartedAt);
}, 1000);

function renderState(st) {
  const { auth: a, runtime: rt, configured } = st;
  const chans = st.config?.channels ?? [];
  setChip('#chip-config',
    chans.length ? `каналы: ${chans.map((c) => '@' + c).join(' ')}` : 'каналы не заданы',
    chans.length ? 'ok' : 'err');
  setChip('#chip-auth', a.login ? 'бот: ' + a.login : 'нет входа', a.login ? (a.status === 'ok' ? 'ok' : 'warn') : 'warn');
  const subsOk = Object.values(rt.eventsub?.subStatus || {}).filter((s) => s === 'ok').length;
  const subsTotal = Object.keys(rt.eventsub?.subStatus || {}).length;
  setChip('#chip-conn',
    rt.eventsub?.connected ? `чат подключен (${subsOk}/${subsTotal || '?'} подписок)` : 'чат отключен',
    rt.eventsub?.connected ? 'ok' : 'err');
  $('#chip-version').textContent = `v${st.version}`;
  const badge = $('#version-badge');
  if (badge) badge.textContent = `v${st.version}`;

  const onboarding = $('#onboarding');
  if (configured && a.login && rt.eventsub?.connected) {
    onboarding.classList.add('hidden');
  } else {
    onboarding.classList.remove('hidden');
    $('#step1').style.opacity = configured ? '.55' : '';
    $('#step2').style.opacity = configured ? '.55' : '';
    $('#step3').style.opacity = a.login ? '.55' : '';
    $('#step4').style.opacity = rt.eventsub?.connected ? '.55' : '';
  }

  // статистика
  // локальный тик каждую секунду: храним старт, компенсируя сдвиг часов браузера (skew сервера = st.now - Date.now())
  __botStartedAt = st.startedAt - (st.now - Date.now());
  $('#st-uptime').textContent = fmtDuration(st.now - st.startedAt);
  $('#st-msg').textContent = st.counters.messagesSeen ?? 0;
  $('#st-cmd').textContent = st.counters.commandsRun ?? 0;
  $('#st-follow').textContent = st.counters.follow ?? 0;
  $('#st-raid').textContent = st.counters.raid ?? 0;
  $('#st-sub').textContent = st.counters.sub ?? 0;

  const uriBot = $('#redirect-uri');
  if (uriBot) uriBot.textContent = `http://localhost:${st.port}/auth/callback`;
  const uriBc = $('#redirect-uri-broadcaster');
  if (uriBc) uriBc.textContent = `http://localhost:${st.port}/auth/broadcaster/callback`;

  // настройки: обновляем поля только если их не редактируют прямо сейчас
  if (!settingsFormTouched) {
    $('#cfg-client-id').value = st.config.clientId || '';
    $('#cfg-port').value = st.port;
  }
  $('#cfg-secret-hint').textContent = st.config.clientSecret ? '(уже сохранён)' : '';

  // список каналов (чипы), предупреждение про аккаунт бота
  renderChannelChips(chans);
  $('#channel-self-warn').classList.toggle('hidden', !(a.login && chans.includes(a.login)));

  // селектор канала для быстрых действий: пересобираем только при изменении списка
  const sel = $('#qa-channel');
  const selKey = chans.join(',');
  if (sel.dataset.key !== selKey) {
    const prev = sel.value;
    sel.innerHTML = chans.length
      ? chans.map((c) => `<option value="${esc(c)}">#${esc(c)}</option>`).join('')
      : '<option value="">каналов нет</option>';
    if (chans.includes(prev)) sel.value = prev;
    sel.dataset.key = selKey;
  }
  $('#auth-login').classList.toggle('hidden', !configured);
  $('#auth-info').innerHTML = a.login
    ? `Вход выполнен: <b>${esc(a.login)}</b>${a.expiresAt ? ` · токен истекает ${new Date(a.expiresAt).toLocaleString('ru-RU')}` : ''}`
    : '';

  // «👑 Награды канала»: статус второго входа (стримером)
  const bc = st.broadcaster ?? {};
  $('#broadcaster-login').classList.toggle('hidden', Boolean(bc.login));
  $('#broadcaster-logout').classList.toggle('hidden', !bc.login);
  $('#broadcaster-info').innerHTML = bc.login
    ? `Вход как стример: <b>${esc(bc.login)}</b>${bc.expiresAt ? ` · токен истекает ${new Date(bc.expiresAt).toLocaleString('ru-RU')}` : ''} — списания наград видны`
    : 'Стример не залогинен — без этого бот не видит списания наград канала.';

  if (rt.lastError) {
    setChip('#chip-conn', 'ошибка', 'err');
  }

  window.__state = st;
}

// ---------------- быстрый опрос ----------------

let pollBusy = false;
async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const [st, logsData] = await Promise.all([
      api('/api/state'),
      api(`/api/logs?chat=${lastIds.chat}&events=${lastIds.events}&system=${lastIds.system}`),
    ]);
    renderState(st);
    renderLogs(logsData);
  } catch (e) {
    // панель недоступна — покажем один раз
  } finally {
    pollBusy = false;
  }
}

// ---------------- команды ----------------

const LEVEL_RU = { everyone: 'все', sub: 'сабы', vip: 'vip', mod: 'моды', broadcaster: 'стример' };

// ---------------- доступ: набор ролей (контекстное меню) ----------------

const ACCESS_ROLES = [
  ['everyone', '🎭 все'],
  ['sub', '💜 сабы'],
  ['vip', '💎 випы'],
  ['mod', '🛡 моды'],
];
const ACCESS_ORDER = { everyone: 0, sub: 1, vip: 2, mod: 3, broadcaster: 4 };

function accessSummary(allow, level) {
  const a = (Array.isArray(allow) ? allow : []).filter(Boolean);
  if (a.length) {
    return [...a].sort((x, y) => (ACCESS_ORDER[x] ?? 9) - (ACCESS_ORDER[y] ?? 9))
      .map((r) => LEVEL_RU[r] ?? r).join(' + ');
  }
  const l = level || 'everyone';
  return l === 'everyone' ? 'все' : `${LEVEL_RU[l] ?? l}+`;
}

/** HTML кнопки выбора доступа. kind: 'custom' (сохранение через 💾) или 'builtin' (применяется сразу). */
function accessBtnHTML(kind, cmdOrName, level, allow) {
  const allowStr = (Array.isArray(allow) ? allow : []).filter(Boolean).join(',');
  const attrs = kind === 'builtin'
    ? `data-kind="builtin" data-cmd="${esc(String(cmdOrName).replace(/^!/, ''))}"`
    : 'data-kind="custom"';
  return `<button class="act ghost apicker-btn" ${attrs} data-level="${esc(level || 'everyone')}" data-allow="${esc(allowStr)}" title="кому можно использовать — ткни чтобы выбрать">${esc(accessSummary(allow, level))}</button>`;
}

// одно меню на всю панель: открывается у кнопки, живёт пока не ткнешь мимо
const apickerMenu = $('#apicker-menu');
let apickerTarget = null;

function openAccessMenu(btn) {
  apickerTarget = btn;
  const level = btn.dataset.level || 'everyone';
  const allow = (btn.dataset.allow || '').split(',').map((s) => s.trim()).filter(Boolean);
  const checked = allow.length ? allow : [level];
  apickerMenu.innerHTML = `
    ${ACCESS_ROLES.map(([r, label]) => `
      <label><input type="checkbox" data-role="${r}" ${checked.includes(r) ? 'checked' : ''} /> ${label}</label>
    `).join('')}
    <div class="ap-note hint">👑 Владелец канала может всегда. Пусто — действует уровень «${esc(LEVEL_RU[level] ?? level)} и выше».</div>
  `;
  apickerMenu.classList.remove('hidden');
  const rect = btn.getBoundingClientRect();
  const menuRect = apickerMenu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 6);
  apickerMenu.style.top = `${top}px`;
  apickerMenu.style.left = `${Math.min(rect.left, window.innerWidth - menuRect.width - 8)}px`;
}

function closeAccessMenu() {
  apickerMenu.classList.add('hidden');
  apickerTarget = null;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.apicker-btn');
  if (btn) {
    e.preventDefault();
    if (apickerTarget === btn) { closeAccessMenu(); return; }
    openAccessMenu(btn);
    return;
  }
  if (!e.target.closest('#apicker-menu')) closeAccessMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccessMenu(); });

apickerMenu.addEventListener('change', async (e) => {
  if (!e.target.dataset?.role || !apickerTarget) return;
  const btn = apickerTarget;
  const role = e.target.dataset.role;
  let roles = [...apickerMenu.querySelectorAll('input[data-role]:checked')].map((i) => i.dataset.role);
  if (role === 'everyone' && e.target.checked) roles = ['everyone']; // «все» включает остальных
  else if (e.target.checked && roles.includes('everyone') && role !== 'everyone') {
    roles = roles.filter((r) => r !== 'everyone'); // выбрали конкретную роль — «все» снимается
  }
  // перерисовать галочки согласно логике выше
  apickerMenu.querySelectorAll('input[data-role]').forEach((i) => { i.checked = roles.includes(i.dataset.role); });
  btn.dataset.allow = roles.join(',');
  btn.textContent = roles.length ? accessSummary(roles) : accessSummary([], btn.dataset.level);

  if (btn.dataset.kind === 'builtin' && btn.dataset.cmd) {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ builtins: { access: { [btn.dataset.cmd]: { allow: roles } } } }),
      });
      toast(`!${btn.dataset.cmd}: доступ — ${roles.length ? accessSummary(roles) : 'по умолчанию'}`);
    } catch (err) {
      toast(err.message, true);
    }
  }
  // кастомные: сохраняется кнопкой 💾 строки (как остальные поля)
});
const MODE_RU = { text: 'один ответ', variants: 'несколько вариантов', roll: 'рандом-число' };
const MODE_ICON = { text: '💬', variants: '🎲', roll: '#️⃣' };
const cmdMode = (c) => c.mode || (c.type === 'random' ? 'variants' : 'text');
const isFun = (c) => cmdMode(c) !== 'text' || Boolean(c.needsTarget) || c.type === 'rp';
let __cmdCache = [];

async function loadCommands() {
  const { custom, builtins } = await api('/api/commands');
  closeAccessMenu(); // таблица перерисовалась — старая кнопка могла исчезнуть
  __cmdCache = custom;
  const body = $('#cmds-body');
  body.innerHTML = custom.map((c) => {
    const mode = cmdMode(c);
    const variants = c.variants || [];
    const contentCell = mode === 'variants'
      ? variantsListHTML(c)
      : `<input class="f-response" value="${esc(c.response || '')}" maxlength="480" title="${mode === 'roll' ? 'текст для чисел вне диапазонов' : 'текст ответа'}" ${mode === 'roll' ? 'placeholder="числа вне диапазонов (можно {roll})"' : ''} />`;
    return `
    <tr data-name="${esc(c.name)}">
      <td class="cellname"><code>!${esc(c.name)}</code> <span class="hint">${c.count || 0}×</span></td>
      <td class="celltype"><span class="chip" title="${esc(MODE_RU[mode])}">${MODE_ICON[mode]} ${MODE_RU[mode]}</span>${c.needsTarget ? '<span class="chip">🎯 @ник</span>' : ''}</td>
      <td class="cellresp">${contentCell}${mode === 'roll' ? `<div class="hint">от ${c.rollMin ?? 0} до ${c.rollMax ?? 100}, диапазонов: ${(c.ranges || []).length} — меню в 🎭 Фан-командах ниже</div>` : ''}</td>
      <td class="celllevel">${accessBtnHTML('custom', c.name, c.level, c.allow)}</td>
      <td class="cellcd"><input class="f-cooldown" type="number" min="0" max="3600" value="${c.cooldown ?? 0}" /></td>
      <td class="cellon"><input class="f-enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''} /></td>
      <td>
        <button class="act cmd-save">💾</button>
        <button class="act ghost cmd-del">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="hint">Пока нет кастомных команд — добавь первую!</td></tr>';

  $('#builtins-body').innerHTML = builtins.map((b) => `
    <tr data-name="${esc(String(b.name).replace(/^!/, ''))}" class="${b.enabled ? '' : 'off'}">
      <td class="cellname"><code>${esc(b.name)}</code></td>
      <td class="cellresp"><span title="${esc(b.label)}">${esc(b.desc || b.label)}</span></td>
      <td class="celllevel">${accessBtnHTML('builtin', b.name, b.level, b.allow)}</td>
      <td class="cellon"><input class="b-enabled" type="checkbox" ${b.enabled ? 'checked' : ''} /></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">Встроенных команд нет 🤷</td></tr>';

  renderFanCommands(custom);
}

// выключение/включение встроенной команды: панель шлёт полный список выключенных имён
$('#builtins-body').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('b-enabled')) return;
  const row = e.target.closest('tr');
  const name = row?.dataset.name || '';
  const checkbox = e.target;
  checkbox.disabled = true;
  try {
    const disabled = $$('#builtins-body tr[data-name]')
      .filter((r) => !r.querySelector('.b-enabled')?.checked)
      .map((r) => r.dataset.name);
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ builtins: { disabled } }) });
    row.classList.toggle('off', !checkbox.checked);
    toast(`!${name} ${checkbox.checked ? 'включена' : 'выключена'}`);
  } catch (err) {
    toast(err.message, true);
    checkbox.checked = !checkbox.checked; // откат
  } finally {
    checkbox.disabled = false;
  }
});

// ---------------- цитаты (карточка на вкладке «Команды») ----------------

async function loadQuotes() {
  const { quotes } = await api('/api/quotes?limit=100');
  $('#quotes-body').innerHTML = quotes.map((q) => `
    <tr data-id="${q.id}">
      <td class="cellcd">#${q.id}</td>
      <td class="cellresp">${esc(q.text)}<div class="hint">${fmtTime(q.at)}</div></td>
      <td class="cellname">${esc(q.by || '—')}</td>
      <td><button class="act ghost q-del" title="удалить цитату">🗑</button></td>
    </tr>`).join('')
    || '<tr><td colspan="4" class="hint">Цитат пока нет — добавь первую или сохрани из чата: !цитата добавить текст (мод+)</td></tr>';
}

$('#quote-add-btn').addEventListener('click', async () => {
  const text = $('#quote-add-text').value.trim();
  if (!text) { toast('Напиши текст цитаты', true); return; }
  try {
    const { quote } = await api('/api/quotes', { method: 'POST', body: JSON.stringify({ text }) });
    $('#quote-add-text').value = '';
    toast(`Цитата #${quote.id} добавлена ✅`);
    loadQuotes().catch(() => {});
  } catch (e) { toast(e.message, true); }
});

$('#quotes-refresh').addEventListener('click', async () => {
  try { await loadQuotes(); toast('Список цитат обновлён'); }
  catch (e) { toast(e.message, true); }
});

$('#quotes-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row || !e.target.classList.contains('q-del')) return;
  const id = Number(row.dataset.id);
  if (!confirm(`Удалить цитату #${id}?`)) return;
  try {
    await api(`/api/quotes?id=${id}`, { method: 'DELETE' });
    toast(`Цитата #${id} удалена 🗑`);
    loadQuotes().catch(() => {});
  } catch (err) { toast(err.message, true); }
});

// ---------------- фан-команды (вкладка «🎭 Фан») ----------------

const RP_PRESETS = [
  { mode: 'text', name: 'обнять', d: '{user} крепко обнимает {target} 🤗' },
  { mode: 'text', name: 'поцеловать', d: '{user} чмокает {target} в щёчку 😘' },
  { mode: 'text', name: 'погладить', d: '{user} гладит {target} по голове 🫶' },
  { mode: 'text', name: 'накормить', d: '{user} угощает {target} пельмешками 🥟' },
  { mode: 'text', name: 'уложить', d: '{user} кутает {target} в пледик: всё, спать! 😴' },
  { mode: 'text', name: 'ударить', d: '{user} отвесила {target} лёгкий подзатыльник 💢' },
  {
    mode: 'roll', name: 'хорни', roll: [0, 100], fallback: '{user} хорни на {roll}% 🤔',
    ranges: [
      [0, 10, '{user} хорни на {roll}% — вы почти не хорни 😌'],
      [11, 39, '{user} хорни на {roll}% — уже хорни 🙈'],
      [40, 60, '{user} хорни на {roll}% — очень хорни 😳'],
      [61, 89, '{user} хорни на {roll}% — срочно остудитесь 🧊'],
      [90, 99, '{user} хорни на {roll}% — СРОЧНО остудитесь 🧊🥵'],
      [100, 100, '{user} хорни на 100% — вы слишком хорни 🔥'],
    ],
  },
  {
    mode: 'roll', name: 'совместимость', roll: [0, 100], fallback: '{user} и {target} совместимы на {roll}% 🤷',
    ranges: [
      [0, 20, '{user} и {target} совместимы на {roll}% — нет химии 💔'],
      [21, 50, '{user} и {target} совместимы на {roll}% — есть искра ✨'],
      [51, 80, '{user} и {target} совместимы на {roll}% — любовь-морковь 💘'],
      [81, 100, '{user} и {target} совместимы на {roll}% — созданы друг для друга 💍'],
    ],
  },
  { mode: 'variants', name: 'шар', d: 'шар говорит: да 🔮|шар говорит: нет ❌|шар говорит: определённо 💯|шар говорит: спроси позже 🤷' },
];

function rangeRowHTML(r = {}) {
  return `
    <div class="rr">
      <input class="rr-from" type="number" min="0" max="1000000" value="${r.from ?? 0}" title="число от" />
      <span class="hint">—</span>
      <input class="rr-to" type="number" min="0" max="1000000" value="${r.to ?? 0}" title="число до" />
      <input class="rr-text" value="${esc(r.text || '')}" maxlength="480" placeholder="ответ (можно {roll}, {user}, {target})" />
      <button class="act ghost rr-del" title="убрать диапазон">✕</button>
    </div>`;
}

function variantRowHTML(v = '') {
  return `
    <div class="vr">
      <input class="f-variant" value="${esc(v)}" maxlength="480" placeholder="вариант ответа — можно {user}, {target}, {random:1-100}" />
      <button class="act ghost v-del" title="убрать вариант">✕</button>
    </div>`;
}

/** Варианты: построчный редактор, свёрнутый в одну строку «вариантов: N» — разворачивается для правки. */
function variantsListHTML(c) {
  const list = c?.variants || [];
  const preview = list.length
    ? `${esc(String(list[0]).slice(0, 60))}${list[0].length > 60 || list.length > 1 ? '…' : ''}`
    : 'пусто';
  const extra = list.length > 1 ? ` <span class="hint">и ещё ${list.length - 1}</span>` : '';
  return `
    <details class="rp-sub">
      <summary>🎲 вариантов: ${list.length} — ${preview}${extra}</summary>
      <div class="f-variants-list">
        ${list.map((v) => variantRowHTML(v)).join('')}
        <button class="act ghost v-add">+ вариант</button>
      </div>
    </details>`;
}

// добавить/убрать вариант — работает в таблице, в фан-меню и в форме создания (делегирование)
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('v-del')) {
    e.target.closest('.vr')?.remove();
    return;
  }
  if (e.target.classList.contains('v-add')) {
    const list = e.target.closest('.f-variants-list');
    if (!list) return;
    e.target.insertAdjacentHTML('beforebegin', variantRowHTML(''));
    const rows = list.querySelectorAll('.vr input.f-variant');
    rows[rows.length - 1]?.focus();
  }
});

/** Собрать варианты из построчного редактора. */
function collectVariants(root) {
  return [...(root?.querySelectorAll('.f-variant') ?? [])].map((i) => i.value.trim()).filter(Boolean);
}

function fanModeFieldsHTML(c, mode) {
  if (mode === 'variants') {
    return `<label class="hint">варианты — по одному в строке, бот выбирает случайно</label>
      ${variantsListHTML(c)}`;
  }
  if (mode === 'roll') {
    const ranges = (c.ranges || []).map((r) => rangeRowHTML(r)).join('') || '<p class="hint">диапазонов пока нет — жми «+ диапазон» (пример: 1 — «почти не хорни», 40-50 — «очень хорни»)</p>';
    return `
      <div class="rp-row">
        <label class="hint">число от <input class="f-min" type="number" min="0" max="1000000" value="${c.rollMin ?? 0}" /></label>
        <label class="hint">до <input class="f-max" type="number" min="0" max="1000000" value="${c.rollMax ?? 100}" /></label>
        <span class="hint">в текстах доступна переменная <code>{roll}</code> — выпавшее число</span>
      </div>
      <label class="hint">ответы по диапазонам чисел</label>
      <div class="rp-ranges" data-ranges>${ranges}
        <button class="act ghost f-range-add">+ диапазон</button>
      </div>
      <label class="hint">числа вне диапазонов → <input class="f-response" value="${esc(c.response || '')}" maxlength="480" placeholder="текст-заглушка (можно {roll})" /></label>`;
  }
  return `<label class="hint">текст ответа</label>
    <input class="f-response" value="${esc(c.response || '')}" maxlength="480" placeholder="{user} обнимает {target} 🤗" />`;
}

function fanItemHTML(c) {
  const mode = cmdMode(c);
  return `
  <details class="rp-item" data-name="${esc(c.name)}">
    <summary>
      <code>!${esc(c.name)}</code>
      <span class="chip" title="${esc(MODE_RU[mode])}">${MODE_ICON[mode]} ${MODE_RU[mode]}</span>
      ${c.needsTarget ? '<span class="chip">🎯 нужен @ник</span>' : ''}
      <span class="hint">${c.count || 0}×</span>
    </summary>
    <div class="rp-config">
      <div class="rp-row">
        <label class="hint">режим
          <select class="f-mode">${Object.entries(MODE_RU).map(([v, l]) => `<option value="${v}"${mode === v ? ' selected' : ''}>${MODE_ICON[v]} ${l}</option>`).join('')}</select>
        </label>
        <label class="hint"><input class="f-target" type="checkbox" ${c.needsTarget ? 'checked' : ''} /> 🎯 нужен @ник</label>
        <label class="hint">шанс % <input class="f-chance" type="number" min="0" max="100" value="${c.chance ?? 100}" title="0 — молчит всегда, 100 — отвечает всегда" /></label>
        <label class="hint">кулдаун, сек <input class="f-cooldown" type="number" min="0" max="3600" value="${c.cooldown ?? 0}" /></label>
        <label class="hint">доступ ${accessBtnHTML('custom', c.name, c.level, c.allow)}</label>
        <label class="hint"><input class="f-enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''} /> вкл</label>
      </div>
      <div class="f-mode-fields">${fanModeFieldsHTML(c, mode)}</div>
      <div class="rp-row">
        <button class="act f-test" title="написать сейчас в канал из «Быстрых действий» (при шансе <100 может молчать)">Тест</button>
        <button class="act f-save">💾 Сохранить</button>
        <button class="act ghost f-del">🗑 Удалить</button>
      </div>
    </div>
  </details>`;
}

function renderFanCommands(custom) {
  const fun = custom.filter(isFun);
  $('#fan-list').innerHTML = fun.map((c) => fanItemHTML(c)).join('') || '<p class="hint">Фан-команд нет — создай выше или ткни готовый шаблон 👇</p>';
  $('#fan-presets').innerHTML = RP_PRESETS.map((p, i) =>
    `<span class="chip preset" data-preset="${i}" title="${esc(p.d || p.fallback || '')}">${MODE_ICON[p.mode]} !${esc(p.name)}</span>`
  ).join('');
}

$('#cmds-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-name]');
  if (!row) return;
  const name = row.dataset.name;
  if (e.target.classList.contains('cmd-del')) {
    if (!confirm(`Удалить команду !${name}?`)) return;
    try {
      await api(`/api/commands?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Команда !${name} удалена`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.classList.contains('cmd-save')) {
    const orig = __cmdCache.find((c) => c.name === name) ?? { name };
    const mode = cmdMode(orig);
    // сохраняем поверх исходника: режимы/диапазоны/таргет не теряются
    const accessBtn = row.querySelector('.apicker-btn');
    const body = {
      ...orig,
      level: accessBtn?.dataset.level || orig.level || 'everyone',
      allow: (accessBtn?.dataset.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
      cooldown: Number(row.querySelector('.f-cooldown').value || 0),
      enabled: row.querySelector('.f-enabled').checked,
    };
    if (mode === 'variants') {
      body.variants = collectVariants(row);
    }
    if (row.querySelector('.f-response')) body.response = row.querySelector('.f-response').value;
    try {
      await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
      toast(`Команда !${name} сохранена`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
  }
});

$('#add-btn').addEventListener('click', async () => {
  const body = {
    name: $('#add-name').value,
    mode: 'text',
    response: $('#add-content').value,
    level: $('#add-level').value,
    cooldown: Number($('#add-cooldown').value || 0),
    enabled: true,
  };
  try {
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    $('#add-name').value = '';
    $('#add-content').value = '';
    toast('Команда добавлена ✅');
    loadCommands();
  } catch (e) { toast(e.message, true); }
});

// --- обработчики фан-студии ---

// смена режима внутри меню — пересобрать поля, сохранив раскрытость
$('#fan-list').addEventListener('change', (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item || !e.target.classList.contains('f-mode')) return;
  const cmd = __cmdCache.find((c) => c.name === item.dataset.name);
  if (!cmd) return;
  const wasOpen = item.open;
  item.outerHTML = fanItemHTML({ ...cmd, mode: e.target.value });
  const fresh = document.querySelector(`#fan-list .rp-item[data-name="${cmd.name}"]`);
  if (fresh) fresh.open = wasOpen;
});

$('#fan-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item) return;
  const name = item.dataset.name;
  const orig = __cmdCache.find((c) => c.name === name) ?? { name };
  if (e.target.classList.contains('rr-del')) { e.target.closest('.rr')?.remove(); return; }
  if (e.target.classList.contains('f-range-add')) {
    item.querySelector('[data-ranges]')?.insertAdjacentHTML('beforeend', rangeRowHTML({}));
    return;
  }
  if (e.target.classList.contains('f-del')) {
    if (!confirm(`Удалить команду !${name}?`)) return;
    try {
      await api(`/api/commands?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Команда !${name} удалена`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.classList.contains('f-test')) {
    try {
      await api('/api/actions/cmdtest', { method: 'POST', body: JSON.stringify({ name, channel: qaChannel() }) });
      toast('Отправлено — глянь чат');
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.classList.contains('f-save')) {
    const mode = item.querySelector('.f-mode')?.value || cmdMode(orig);
    const accessBtn = item.querySelector('.apicker-btn');
    const body = {
      ...orig,
      name,
      mode,
      needsTarget: item.querySelector('.f-target').checked,
      chance: Number(item.querySelector('.f-chance').value ?? 100),
      cooldown: Number(item.querySelector('.f-cooldown').value || 0),
      level: accessBtn?.dataset.level || orig.level || 'everyone',
      allow: (accessBtn?.dataset.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
      enabled: item.querySelector('.f-enabled').checked,
    };
    if (mode === 'variants') {
      body.variants = collectVariants(item);
    } else if (mode === 'roll') {
      body.rollMin = Number(item.querySelector('.f-min').value ?? 0);
      body.rollMax = Number(item.querySelector('.f-max').value ?? 100);
      body.ranges = [...item.querySelectorAll('.rr')].map((rr) => ({
        from: Number(rr.querySelector('.rr-from').value || 0),
        to: Number(rr.querySelector('.rr-to').value || 0),
        text: rr.querySelector('.rr-text').value.trim(),
      })).filter((r) => r.text);
      body.response = item.querySelector('.f-response').value;
    } else {
      body.response = item.querySelector('.f-response').value;
    }
    try {
      await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
      toast(`!${name} сохранена ✅`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
  }
});

// форма создания фан-команды
$('#fan-add-mode').addEventListener('change', () => {
  const mode = $('#fan-add-mode').value;
  $('#fan-add-min').classList.toggle('hidden', mode !== 'roll');
  $('#fan-add-max').classList.toggle('hidden', mode !== 'roll');
  $('#fan-add-text').classList.toggle('hidden', mode === 'variants');
  $('#fan-add-variants').classList.toggle('hidden', mode !== 'variants');
  if (mode === 'variants' && !$('#fan-add-variants .f-variant')) {
    $('#fan-add-variants .f-variants-list').insertAdjacentHTML('afterbegin', variantRowHTML(''));
  }
  const ph = { text: 'текст ответа — например: {user} обнимает {target} 🤗', roll: 'числа вне диапазонов (можно {roll}) — сами диапазоны добавишь в меню' };
  $('#fan-add-text').placeholder = ph[mode] || ph.text;
});

$('#fan-add-btn').addEventListener('click', async () => {
  const mode = $('#fan-add-mode').value;
  const content = $('#fan-add-text').value;
  const body = {
    name: $('#fan-add-name').value,
    mode,
    needsTarget: $('#fan-add-target').checked,
    level: 'everyone',
    cooldown: 5,
    chance: 100,
    enabled: true,
  };
  if (mode === 'variants') {
    body.variants = collectVariants($('#fan-add-variants'));
    if (!body.variants.length) { toast('Добавь хотя бы один вариант (кнопка «+ вариант»)', true); return; }
  }
  else if (mode === 'roll') {
    body.rollMin = Number($('#fan-add-min').value ?? 0);
    body.rollMax = Number($('#fan-add-max').value ?? 100);
    body.response = content; // заглушка; диапазоны добавляются в меню
  } else body.response = content;
  try {
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    $('#fan-add-name').value = '';
    $('#fan-add-text').value = '';
    const vl = $('#fan-add-variants .f-variants-list');
    if (vl) {
      vl.querySelectorAll('.vr').forEach((r) => r.remove());
      vl.insertAdjacentHTML('afterbegin', variantRowHTML(''));
    }
    toast('Команда создана ✅ Раскрыл её в списке — донастрой');
    loadCommands();
    const fresh = document.querySelector(`#fan-list .rp-item[data-name="${String(body.name).toLowerCase().replace(/^!/, '')}"]`);
    if (fresh) fresh.open = true;
  } catch (e) { toast(e.message, true); }
});

$('#fan-presets').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip[data-preset]');
  if (!chip) return;
  const p = RP_PRESETS[Number(chip.dataset.preset)];
  try {
    const { custom } = await api('/api/commands');
    if (custom.some((c) => c.name === p.name)) {
      toast(`!${p.name} уже есть — правь её в списке`, true);
      return;
    }
    const body = { name: p.name, mode: p.mode, needsTarget: false, level: 'everyone', cooldown: 5, chance: 100, enabled: true };
    if (p.mode === 'text') body.response = p.d;
    else if (p.mode === 'variants') body.variants = p.d.split('|').map((s) => s.trim()).filter(Boolean);
    else {
      body.rollMin = p.roll[0];
      body.rollMax = p.roll[1];
      body.ranges = p.ranges.map(([from, to, text]) => ({ from, to, text }));
      body.response = p.fallback;
    }
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    toast(`!${p.name} добавлена ✅ Раскрой и правь под себя`);
    loadCommands();
  } catch (err) { toast(err.message, true); }
});

// ---------------- события ----------------

const KIND_RU = { follow: 'Новый фоллоу', raid: 'Рейд', sub: 'Новая подписка', resub: 'Продление подписки', subgift: 'Подаренная подписка' };

async function loadSettings() {
  const [st, media] = await Promise.all([api('/api/settings'), api('/api/media')]);
  window.__settings = st;
  __mediaFiles = media.files ?? [];
  const holder = $('#events-list');
  holder.innerHTML = '<div class="evcards"></div>';
  const cards = holder.firstChild;
  for (const [kind, cfg] of Object.entries(st.events)) {
    const a = st.alerts?.[kind] ?? {};
    const div = document.createElement('div');
    div.className = 'evcard';
    div.dataset.kind = kind;
    div.innerHTML = `
      <h3>${KIND_RU[kind] ?? kind}</h3>
      <input type="text" class="f-template" value="${esc(cfg.template)}" maxlength="400" />
      <label>режим
        <select class="f-mode">
          <option value="chat" ${cfg.mode === 'chat' ? 'selected' : ''}>текст бота</option>
          <option value="announce" ${cfg.mode === 'announce' ? 'selected' : ''}>анонс (${esc(cfg.color)})</option>
        </select>
      </label>
      <label>цвет анонса
        <select class="f-color">
          ${['purple', 'primary', 'blue', 'green', 'orange'].map((c) => `<option value="${c}" ${cfg.color === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </label>
      <label><input type="checkbox" class="f-pin" ${cfg.pin ? 'checked' : ''} /> закрепить на 20 минут (для режима «текст»)</label>
      <label><input type="checkbox" class="f-enabled" ${cfg.enabled ? 'checked' : ''} /> реакция включена</label>
      <button class="act ghost a-open" title="медиа, звук, громкость алерта на оверлее">${alertSummaryHTML(a, kind)}</button>
      <div class="row">
        <button class="act ev-save">Сохранить</button>
        <button class="act ghost ev-test" data-kind="${kind}">Тест чата</button>
      </div>
    `;
    cards.appendChild(div);
  }
  renderMediaFiles();
  $('#so-template').value = st.so?.template ?? '';
  renderAso();
  renderAutoPin();
  renderTimers();
  renderObs();
  renderRedemptions();
}

// однострочный статус алерта на кнопке карточки: клик = открыть модалку
function alertSummaryHTML(a = {}, kind = '') {
  const on = a.enabled !== false;
  const media = a.media ? `🎬 ${a.media}` : 'эмодзи';
  const sound = a.sound ? `🔊 ${a.sound}` : 'без звука';
  const dur = `${a.duration ?? 6}с`;
  return `⚙ Алерт — ${on ? `${media} · ${sound} · ${dur}` : 'выключен'}`;
}

// перечитать поля карточки и переписать текст кнопки «⚙ Алерт»
function refreshAlertSummary(card) {
  const btn = card.querySelector('.a-open');
  if (!btn) return;
  btn.innerHTML = alertSummaryHTML(window.__settings?.alerts?.[card.dataset.kind] ?? {}, card.dataset.kind);
}

// «＋ загрузить файл…» прямо в селектах медиа/звука (внутри модалки)
const ALERT_UPLOAD_ACCEPT = {
  media: 'video/mp4,video/webm,video/quicktime,video/ogg,image/gif,image/apng,image/png,image/webp,image/jpeg,image/svg+xml',
  sound: 'audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac',
};
async function alertPickAndUpload(kind) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = ALERT_UPLOAD_ACCEPT[kind] || '*/*';
  const file = await new Promise((resolve) => {
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
  if (!file) return null;
  const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  if (!__mediaFiles.includes(file.name)) __mediaFiles.push(file.name);
  __mediaFiles.sort();
  renderMediaFiles();
  toast(`«${file.name}» загружен ✅`);
  return file.name;
}

// ---------------- модалка «настройка алерта» ----------------

const AM_EMOJI = { follow: '💜', sub: '🎉', resub: '💖', subgift: '🎁', raid: '🚀' };
const AM_SUB = { follow: 'новый фолловер', sub: 'новая подписка', resub: 'продление подписки', subgift: 'подаренная подписка', raid: 'рейд на канал' };
const amModal = $('#alert-modal');
let amKind = null;
let amPreviewSound = false; // звук видео в превью: переживает перерисовки, сбрасывается при открытии модалки

function amSelOptions(kind, cur, empty) {
  const list = __mediaFiles.filter((f) => (kind === 'media' ? VISUAL_EXT : AUDIO_EXT).includes(fileExt(f)));
  return [`<option value="">${empty}</option>`,
    ...list.map((f) => `<option value="${esc(f)}" ${cur === f ? 'selected' : ''}>${esc(f)}</option>`),
    '<option value="__upload__">＋ загрузить файл…</option>'].join('');
}

function openAlertModal(kind) {
  amKind = kind;
  amPreviewSound = false; // звук превью по умолчанию выключен
  const a = window.__settings?.alerts?.[kind] ?? {};
  $('#am-title').textContent = `📺 Алерт — ${KIND_RU[kind] ?? kind}`;
  $('#am-enabled').checked = a.enabled !== false;
  $('#am-template').value = a.template || '';
  $('#am-media').innerHTML = amSelOptions('media', a.media || '', '— без медиа (эмодзи) —');
  $('#am-sound').innerHTML = amSelOptions('sound', a.sound || '', '— без звука —');
  $('#am-volume').value = a.soundVolume ?? 85;
  $('#am-volume-val').textContent = String(a.soundVolume ?? 85);
  $('#am-duration').value = a.duration ?? 6;
  amUpdatePreview();
  amModal.classList.remove('hidden');
}

function closeAlertModal() {
  amModal.classList.add('hidden');
  amKind = null;
  amModal.querySelector('video')?.pause?.();
}

// живое превью плашки — как она выглядит в оверлее
function amUpdatePreview() {
  const box = $('#am-preview');
  const kind = amKind || 'follow';
  const enabled = $('#am-enabled').checked;
  if (!enabled) {
    box.innerHTML = '<span class="hint">алерт выключен — на оверлее ничего не покажется</span>';
    return;
  }
  const media = $('#am-media').value;
  let mediaHTML = `<div class="am-emoji">${AM_EMOJI[kind] || '✨'}</div>`;
  if (media) {
    const src = `/media/${encodeURIComponent(media)}`;
    if (fileExt(media) && ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(fileExt(media))) {
      mediaHTML = `<div class="am-media"><video src="${src}" autoplay loop muted playsinline></video></div>`;
    } else if (!AUDIO_EXT.includes(fileExt(media))) {
      mediaHTML = `<div class="am-media"><img src="${src}" alt=""></div>`;
    }
  }
  const text = $('#am-template').value || 'текст плашки…';
  const isVideo = media && ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(fileExt(media));
  box.innerHTML = `<div class="am-alert am-k-${kind}">${mediaHTML}
    <div class="am-text">${esc(text)}<small>${AM_SUB[kind] || ''}</small></div></div>
    ${isVideo ? `<button class="act ghost am-hear-btn">${amPreviewSound ? '🔇 выключить звук' : '🔊 включить звук превью'}</button>` : ''}`;
  amApplyPreviewSound();
}

// применить состояние звука превью к текущему видео + кнопке
function amApplyPreviewSound() {
  const vid = $('#am-preview video');
  if (vid) {
    vid.muted = !amPreviewSound;
    if (amPreviewSound) vid.volume = Math.max(0.001, Math.min(1, Number($('#am-volume').value) / 100));
    vid.title = 'клик — включить/выключить звук';
    vid.style.cursor = 'pointer';
  }
}

function amTogglePreviewSound() {
  amPreviewSound = !amPreviewSound;
  amApplyPreviewSound();
  const btn = $('#am-preview .am-hear-btn');
  if (btn) btn.textContent = amPreviewSound ? '🔇 выключить звук' : '🔊 включить звук превью';
}

// клик по кнопке «🔊 включить звук превью» или по самому видео — звук с выбранной громкостью
$('#am-preview').addEventListener('click', (e) => {
  if (e.target.closest('.am-hear-btn') || e.target.tagName === 'VIDEO') amTogglePreviewSound();
});

// громкость меняется — если звук превью уже включён, подтягиваем сразу
$('#am-volume').addEventListener('input', () => {
  $('#am-volume-val').textContent = $('#am-volume').value;
  if (amPreviewSound) amApplyPreviewSound();
});

function amRefreshCard() {
  const card = document.querySelector(`#events-list .evcard[data-kind="${amKind}"]`);
  if (card) refreshAlertSummary(card);
}

$('#events-list').addEventListener('click', (e) => {
  if (e.target.closest('.a-open')) openAlertModal(e.target.closest('.evcard')?.dataset.kind);
});

// живое обновление превью при правке любого поля
['am-enabled', 'am-template', 'am-media', 'am-sound', 'am-duration'].forEach((id) => {
  $('#' + id).addEventListener('change', () => {
    // «＋ загрузить файл…»: выбираем файл, грузим, подставляем в селект
    if ((id === 'am-media' || id === 'am-sound') && $('#' + id).value === '__upload__') {
      const sel = $('#' + id);
      sel.value = '';
      const field = id === 'am-media' ? 'media' : 'sound';
      alertPickAndUpload(field)
        .then((name) => {
          if (!name) return;
          if (![...sel.options].some((o) => o.value === name)) {
            sel.querySelector('option[value="__upload__"]').insertAdjacentHTML('beforebegin', `<option value="${esc(name)}">${esc(name)}</option>`);
          }
          sel.value = name;
          amUpdatePreview();
        })
        .catch((err) => toast(err.message, true));
      return;
    }
    amUpdatePreview();
  });
});
$('#am-template').addEventListener('input', amUpdatePreview);
$('#am-play').addEventListener('click', () => {
  const name = $('#am-sound').value;
  if (!name) { toast('Сначала выбери звук (или загрузи — «＋ загрузить файл…»)', true); return; }
  try {
    const a = new Audio(`/media/${encodeURIComponent(name)}?t=${Date.now()}`);
    a.volume = Math.max(0, Math.min(1, Number($('#am-volume').value) / 100)) || 0.001;
    a.play().catch(() => toast('Браузер не дал проиграть — ткни ещё раз', true));
  } catch { /* ничего страшного */ }
});

$('#am-save').addEventListener('click', async () => {
  if (!amKind) return;
  const alert = {
    enabled: $('#am-enabled').checked,
    template: $('#am-template').value,
    media: $('#am-media').value,
    sound: $('#am-sound').value,
    soundVolume: Math.max(0, Math.min(100, Number($('#am-volume').value) || 0)),
    duration: Math.max(2, Math.min(20, Number($('#am-duration').value) || 6)),
  };
  try {
    const s = await putSettings({ alerts: { [amKind]: alert } });
    amRefreshCard();
    closeAlertModal();
    toast('Алерт сохранён ✅');
  } catch (err) { toast(err.message, true); }
});

$('#am-test').addEventListener('click', async () => {
  if (!amKind) return;
  try {
    await api('/api/actions/overlaytest', { method: 'POST', body: JSON.stringify({ kind: amKind }) });
    toast('Алерт отправлен — смотри оверлей (страница должна быть открыта)');
  } catch (err) { toast(err.message, true); }
});

$('#am-close').addEventListener('click', closeAlertModal);
amModal.addEventListener('click', (e) => { if (e.target === amModal) closeAlertModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !amModal.classList.contains('hidden')) closeAlertModal(); });

$('#events-list').addEventListener('click', async (e) => {
  const card = e.target.closest('.evcard');
  if (!card) return;
  const kind = card.dataset.kind;
  if (e.target.classList.contains('ev-save')) {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          events: {
            [kind]: {
              template: card.querySelector('.f-template').value,
              mode: card.querySelector('.f-mode').value,
              color: card.querySelector('.f-color').value,
              pin: card.querySelector('.f-pin').checked,
              enabled: card.querySelector('.f-enabled').checked,
            },
          },
          // алерты настраиваются в модалке (кнопка «⚙ Алерт») — туда их и сохраняем
        }),
      });
      toast('Событие сохранено ✅');
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.classList.contains('ev-test')) {
    try {
      await api('/api/actions/test', { method: 'POST', body: JSON.stringify({ kind, channel: qaChannel() }) });
      toast('Тест отправлен в чат — смотри ленту событий');
    } catch (err) { toast(err.message, true); }
  }
});

$('#so-save').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ so: { template: $('#so-template').value } }),
    });
    toast('Шаблон шатаута сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

// ---------------- OBS (obs-websocket 5) ----------------

function renderObs() {
  const o = window.__settings?.obs;
  if (!o) return;
  $('#obs-enabled').checked = Boolean(o.enabled);
  $('#obs-host').value = o.host ?? '127.0.0.1';
  $('#obs-port').value = o.port ?? 4455;
  $('#obs-password').value = '';
  $('#obs-result').textContent = '';
}

$('#obs-save').addEventListener('click', async () => {
  const host = String($('#obs-host').value).trim();
  const port = Number($('#obs-port').value);
  if (!host) { toast('Укажи хост OBS (обычно 127.0.0.1)', true); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { toast('Порт OBS — целое число 1–65535', true); return; }
  const obs = { enabled: $('#obs-enabled').checked, host, port };
  if ($('#obs-password').value) obs.password = $('#obs-password').value; // пустое поле — не затираем сохранённый пароль
  try {
    await putSettings({ obs });
    renderObs();
    toast('Настройки OBS сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#obs-test').addEventListener('click', async () => {
  const btn = $('#obs-test');
  const out = $('#obs-result');
  btn.disabled = true;
  out.textContent = 'Проверяю связь с OBS…';
  try {
    const body = { host: String($('#obs-host').value).trim(), port: Number($('#obs-port').value) || 4455 };
    if ($('#obs-password').value) body.password = $('#obs-password').value;
    const r = await api('/api/actions/obstest', { method: 'POST', body: JSON.stringify(body) });
    const scenes = Array.isArray(r.scenes) ? r.scenes.join(', ') : '—';
    out.textContent = `✅ OBS на связи${r.current ? ` — сейчас сцена: ${r.current}` : ''}. Сцены: ${scenes}`;
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------------- автошатауты ----------------

function renderAso() {
  const a = window.__settings?.autoShoutouts;
  if (!a) return;
  $('#aso-enabled').checked = Boolean(a.enabled);
  $('#aso-cooldown').value = a.cooldownMinutes ?? 240;
  $('#aso-default').value = a.defaultTemplate ?? '';
  asoLoad(window.__settings?.shoutoutOverlay);
  const body = $('#aso-body');
  body.innerHTML = (a.users ?? []).map((u) => `
    <tr data-login="${esc(u.login)}">
      <td class="cellname"><b>@${esc(u.login)}</b></td>
      <td class="cellresp"><input class="aso-text" value="${esc(u.text || '')}" maxlength="400" /></td>
      <td>
        <button class="act aso-test" title="проверить прямо сейчас">Тест</button>
        <button class="act aso-save-row" title="сохранить текст">💾</button>
        <button class="act ghost aso-del" title="убрать из списка">🗑</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="3" class="hint">Список пуст — добавь стримеров ниже</td></tr>';
}

function currentAsoUsers() {
  return (window.__settings?.autoShoutouts?.users ?? []).map((u) => ({ ...u }));
}

async function putSettings(patch) {
  const st = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  window.__settings = st;
  renderAso();
  renderAutoPin();
  renderTimers();
  renderRedemptions();
  return st; // важно: модалка алерта и другие вызовы кладут это в window.__settings
}

$('#aso-save').addEventListener('click', async () => {
  try {
    await putSettings({
      autoShoutouts: {
        enabled: $('#aso-enabled').checked,
        cooldownMinutes: Number($('#aso-cooldown').value) || 240,
        defaultTemplate: $('#aso-default').value,
      },
    });
    toast('Автошатауты сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#aso-add-btn').addEventListener('click', async () => {
  const login = $('#aso-add-login').value.trim().replace(/^@/, '').toLowerCase();
  if (!login) return;
  const users = currentAsoUsers();
  if (users.some((u) => u.login === login)) { toast('Уже в списке', true); return; }
  if (users.length >= 50) { toast('Максимум 50 человек', true); return; }
  users.push({ login, text: $('#aso-add-text').value.trim() });
  try {
    await putSettings({ autoShoutouts: { users } });
    $('#aso-add-login').value = '';
    $('#aso-add-text').value = '';
    toast('Стример добавлен ✅');
  } catch (e) { toast(e.message, true); }
});

$('#aso-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-login]');
  if (!row) return;
  const login = row.dataset.login;
  try {
    if (e.target.classList.contains('aso-del')) {
      if (!confirm(`Убрать @${login} из автошатаутов?`)) return;
      await putSettings({ autoShoutouts: { users: currentAsoUsers().filter((u) => u.login !== login) } });
      toast('Убрано 🗑');
    } else if (e.target.classList.contains('aso-save-row')) {
      const text = row.querySelector('.aso-text').value;
      const users = currentAsoUsers().map((u) => (u.login === login ? { ...u, text } : u));
      await putSettings({ autoShoutouts: { users } });
      toast('Текст сохранён ✅');
    } else if (e.target.classList.contains('aso-test')) {
      await api('/api/actions/autosotest', { method: 'POST', body: JSON.stringify({ login, channel: qaChannel() }) });
      toast('Тест: шатаут отправлен (если лимиты Twitch сейчас позволяют)');
    }
  } catch (err) { toast(err.message, true); }
});

// ---------------- автозакреп ----------------

function renderAutoPin() {
  const ap = window.__settings?.autoPin;
  if (!ap) return;
  $('#ap-enabled').checked = Boolean(ap.enabled);
  $('#ap-mode').value = ap.mode ?? 'stream';
  $('#ap-template').value = ap.template ?? '';
}

$('#ap-save').addEventListener('click', async () => {
  try {
    await putSettings({
      autoPin: {
        enabled: $('#ap-enabled').checked,
        mode: $('#ap-mode').value,
        template: $('#ap-template').value,
      },
    });
    toast('Автозакреп сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

$('#ap-test').addEventListener('click', async () => {
  try {
    await api('/api/actions/autopintest', { method: 'POST', body: JSON.stringify({ channel: qaChannel() }) });
    toast('Отправлено и закреплено — глянь чат 📌');
  } catch (e) { toast(e.message, true); }
});

// ---------------- таймеры (периодические сообщения) ----------------

const TIMER_MODES = [
  ['time', 'по времени'],
  ['messages', 'по сообщениям'],
  ['and', 'и время, и сообщения'],
  ['or', 'или время, или сообщения'],
];

function renderTimers() {
  const t = window.__settings?.timers;
  if (!t) return;
  $('#t-enabled').checked = Boolean(t.enabled);
  $('#t-onlylive').checked = t.onlyWhenLive !== false;
  const body = $('#t-body');
  body.innerHTML = (t.items ?? []).map((x) => `
    <tr data-id="${esc(x.id)}">
      <td class="cellname"><input class="t-name" value="${esc(x.name || '')}" maxlength="40" /></td>
      <td class="cellresp"><input class="t-text" value="${esc(x.text || '')}" maxlength="400" /></td>
      <td class="cellcd"><input class="t-interval" type="number" min="1" max="720" value="${x.intervalMinutes ?? 15}" title="минут между выходами" /></td>
      <td class="cellcd"><input class="t-minmsg" type="number" min="1" max="1000" value="${x.minMessages ?? 5}" title="сколько сообщений в чате ждать" /></td>
      <td class="cellmode"><select class="t-mode">${TIMER_MODES.map(([v, l]) => `<option value="${v}"${(x.mode || 'time') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="cellon"><input class="t-enabled" type="checkbox" ${x.enabled !== false ? 'checked' : ''} /></td>
      <td>
        <button class="act t-test" title="написать сейчас в выбранный канал">Тест</button>
        <button class="act t-save-row" title="сохранить">💾</button>
        <button class="act ghost t-del" title="удалить">🗑</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="hint">Таймеров нет — добавь первый ниже</td></tr>';
}

function currentTimers() {
  return (window.__settings?.timers?.items ?? []).map((x) => ({ ...x }));
}

$('#t-save').addEventListener('click', async () => {
  try {
    await putSettings({
      timers: {
        enabled: $('#t-enabled').checked,
        onlyWhenLive: $('#t-onlylive').checked,
      },
    });
    toast('Таймеры сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#t-add-btn').addEventListener('click', async () => {
  const text = $('#t-add-text').value.trim();
  if (!text) { toast('Нужен текст сообщения', true); return; }
  const items = currentTimers();
  if (items.length >= 30) { toast('Максимум 30 таймеров', true); return; }
  items.push({
    id: crypto.randomUUID?.() ?? `t${Date.now()}`,
    name: $('#t-add-name').value.trim(),
    text,
    intervalMinutes: Number($('#t-add-interval').value) || 15,
    minMessages: Number($('#t-add-minmsg').value) || 5,
    mode: $('#t-add-mode').value,
    enabled: true,
  });
  try {
    await putSettings({ timers: { items } });
    $('#t-add-name').value = '';
    $('#t-add-text').value = '';
    toast('Таймер добавлен ✅ Первый выход — через указанный интервал');
  } catch (e) { toast(e.message, true); }
});

$('#t-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  try {
    if (e.target.classList.contains('t-del')) {
      if (!confirm('Удалить этот таймер?')) return;
      await putSettings({ timers: { items: currentTimers().filter((x) => x.id !== id) } });
      toast('Таймер удалён 🗑');
    } else if (e.target.classList.contains('t-save-row')) {
      const items = currentTimers().map((x) => (x.id === id ? {
        ...x,
        name: row.querySelector('.t-name').value,
        text: row.querySelector('.t-text').value,
        intervalMinutes: Number(row.querySelector('.t-interval').value) || 5,
        minMessages: Number(row.querySelector('.t-minmsg').value) || 5,
        mode: row.querySelector('.t-mode').value,
        enabled: row.querySelector('.t-enabled').checked,
      } : x));
      await putSettings({ timers: { items } });
      toast('Таймер сохранён ✅');
    } else if (e.target.classList.contains('t-test')) {
      await api('/api/actions/timertest', { method: 'POST', body: JSON.stringify({ id, channel: qaChannel() }) });
      toast('Отправлено в выбранный канал — глянь чат');
    }
  } catch (err) { toast(err.message, true); }
});

// ---------------- награды канала (Channel Points) ----------------

const RW_ACTIONS = [
  ['song', '🎵 песня'],
  ['meme', '🎬 мем'],
  ['wheel', '🎡 колесо'],
  ['say', '🗣 TTS'],
  ['command', '⌨️ команда'],
];

function renderRedemptions() {
  const st = window.__settings?.redemptions;
  if (!st) return;
  $('#rw-cooldown').value = st.cooldown ?? 30;
  $('#rw-enabled').checked = st.enabled !== false;
  $('#rw-body').innerHTML = (st.mappings ?? []).map((m) => `
    <tr class="rw-row" data-action="${esc(m.action ?? 'song')}">
      <td class="cellresp"><input class="rw-name" value="${esc(m.rewardName ?? '')}" maxlength="100" placeholder="как награда называется на Twitch" /></td>
      <td class="cellmode"><select class="rw-action">${RW_ACTIONS.map(([v, l]) => `<option value="${v}"${m.action === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="cellon"><input class="rw-enabled" type="checkbox" ${m.enabled !== false ? 'checked' : ''} /></td>
      <td><button class="act ghost rw-del" title="убрать награду">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">наград нет — добавь ниже (название должно совпадать с наградой на Twitch)</td></tr>';
}

function collectRedemptions() {
  const mappings = [...document.querySelectorAll('#rw-body .rw-row')].map((row) => ({
    rewardName: row.querySelector('.rw-name').value.trim(),
    action: row.querySelector('.rw-action').value,
    enabled: row.querySelector('.rw-enabled').checked,
  })).filter((m) => m.rewardName);
  return {
    enabled: $('#rw-enabled').checked,
    cooldown: Number($('#rw-cooldown').value) || 30,
    mappings,
  };
}

$('#rw-save').addEventListener('click', async () => {
  try {
    await putSettings({ redemptions: collectRedemptions() });
    renderRedemptions();
    toast('Награды канала сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#rw-add').addEventListener('click', () => {
  $('#rw-body').insertAdjacentHTML('beforeend', `
    <tr class="rw-row">
      <td class="cellresp"><input class="rw-name" placeholder="${esc($('#rw-add-name').value.trim() || 'заказать песню')}" maxlength="100" /></td>
      <td class="cellmode"><select class="rw-action">${RW_ACTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></td>
      <td class="cellon"><input class="rw-enabled" type="checkbox" checked /></td>
      <td><button class="act ghost rw-del">🗑</button></td>
    </tr>`);
  $('#rw-add-name').value = '';
});

$('#rw-body').addEventListener('click', (e) => {
  if (e.target.classList.contains('rw-del')) e.target.closest('tr')?.remove();
});

$('#rw-add-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#rw-add').click();
});

$('#rw-test').addEventListener('click', async () => {
  try {
    await api('/api/actions/redemptiontest', { method: 'POST', body: '{}' });
    toast('Тестовая награда отправлена — смотри оверлей (страница должна быть открыта)');
  } catch (e) { toast(e.message, true); }
});

$('#broadcaster-logout').addEventListener('click', async () => {
  if (!confirm('Сбросить токен стримера? Бот перестанет видеть списания наград.')) return;
  try {
    await api('/api/broadcaster/logout', { method: 'POST' });
    toast('Токен стримера сброшен');
    poll();
  } catch (e) { toast(e.message, true); }
});

$('#redirect-uri-broadcaster')?.addEventListener('click', (e) => {
  navigator.clipboard?.writeText(e.target.textContent).then(() => toast('Redirect URL скопирован'));
});

// ---------------- оверлей (глобальные настройки) ----------------
// алерты КОНКРЕТНЫХ событий настраиваются в их карточках: вкладка «События»

let __mediaFiles = [];
// разделение файлов по типу: для колонок «Звук» и «Медиа»
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const VISUAL_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'gif', 'apng', 'png', 'webp', 'jpg', 'jpeg', 'svg'];
const fileExt = (n) => String(n || '').split('.').pop().toLowerCase();
const fileKind = (n) => {
  const e = fileExt(n);
  if (AUDIO_EXT.includes(e)) return 'звук';
  if (VISUAL_EXT.includes(e)) return 'медиа';
  return 'файл';
};

// семафор: вкладка Оверлей отрисовала актуальные настройки сервера.
// До этого «Сохранить» держим заблокированным — иначе соберём алерты из
// пустого DOM и молча выключим все алерты и TTS (панель свежая, бот перезапускался).
let __overlayLoaded = false;

async function loadOverlaySettings() {
  const [st, media] = await Promise.all([api('/api/settings'), api('/api/media')]);
  const a = st.alerts ?? {};
  window.__settings = st; // свежие значения по умолчанию для TTS-голоса (не DOM-дефолт)
  __mediaFiles = media.files ?? [];
  $('#ov-url').value = `${location.origin}/overlay`;
  $('#ov-open').href = `${location.origin}/overlay?test=follow`;
  $('#ov-enabled').checked = Boolean(a.enabled);
  $('#ov-eventlist').checked = Boolean(a.eventList?.enabled);
  renderMediaFiles();
  // TTS-блок «🔊 Озвучка»
  const tts = a.tts ?? {};
  $('#tts-enabled').checked = Boolean(tts.enabled);
  $('#tts-rate').value = tts.rate ?? 1;
  $('#tts-volume').value = tts.volume ?? 1;
  fillTtsVoices(String(tts.voiceName ?? ''));
  __overlayLoaded = true; // настройки отрисованы — теперь можно собирать и слать
}

// списочек файлов алертов: чипы с типом и кнопкой удаления
function renderMediaFiles() {
  const box = $('#media-files');
  if (!box) return;
  box.innerHTML = __mediaFiles.map((f) =>
    `<span class="chip">${esc(f)} · ${fileKind(f)} <button class="act ghost m-del" data-name="${esc(f)}" title="удалить файл">✕</button></span>`
  ).join('') || '<span class="hint">Пока пусто — загрузи первый файл выше или кинь в папку overlay-media/</span>';
}

$('#media-files').addEventListener('click', async (e) => {
  const btn = e.target.closest('.m-del');
  if (!btn) return;
  const name = btn.dataset.name;
  if (!confirm(`Удалить файл «${name}»?`)) return;
  try {
    await api(`/api/media?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(`Файл «${name}» удалён`);
    loadSettings(); // перерисовать карточки событий (селекты медиа/звука) и чипы файлов
  } catch (err) { toast(err.message, true); }
});

$('#media-upload').addEventListener('click', async () => {
  const input = $('#media-file');
  const file = input?.files?.[0];
  if (!file) { toast('Сначала выбери файл', true); return; }
  $('#media-up-hint').textContent = 'загружаю…';
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    input.value = '';
    $('#media-up-hint').textContent = '';
    toast(`«${file.name}» загружен ✅`);
    loadSettings(); // перерисовать карточки событий (селекты медиа/звука) и чипы файлов
  } catch (err) {
    $('#media-up-hint').textContent = '';
    toast(err.message, true);
  }
});

// список голосов берём из браузера панели (Web Speech API), русские — первыми
function ttsVoices() {
  try { return window.speechSynthesis?.getVoices?.() ?? []; } catch { return []; }
}

// сохранённый в настройках голос — единственный источник правды для дефолта,
// DOM-дефолт (пустая опция «— по умолчанию —») значение не затирает
function storedTtsVoice() {
  try { return String(window.__settings?.alerts?.tts?.voiceName ?? ''); } catch { return ''; }
}

function fillTtsVoices(selected = '') {
  const sel = $('#tts-voice');
  if (!sel) return;
  // значением по умолчанию всегда — сохранённое из настроек, а не DOM-дефолт
  const want = String(selected || storedTtsVoice());
  const voices = ttsVoices();
  const hint = $('#tts-hint');
  const opt = (v) => `<option value="${esc(v.name)}" ${v.name === want ? 'selected' : ''}>${esc(v.name)}</option>`;
  let html = '<option value="">— по умолчанию (первый русский) —</option>';
  if (voices.length) {
    const ru = voices.filter((v) => /^ru/i.test(String(v.lang || '')));
    const other = voices.filter((v) => !/^ru/i.test(String(v.lang || '')));
    html += (ru.length ? `<optgroup label="Русские">${ru.map(opt).join('')}</optgroup>` : '')
      + (other.length ? `<optgroup label="Остальные">${other.map(opt).join('')}</optgroup>` : '');
    if (hint) hint.textContent = '';
  } else if (hint) {
    hint.textContent = 'speechSynthesis' in window ? 'голоса ещё грузятся — обновится само…' : 'браузер не поддерживает синтез речи';
  }
  // фантом: текущее имя из настроек держим в списке ВСЕГДА (и при пустом списке),
  // иначе первый «Сохранить» ушёл бы с voiceName:'' и настройка молча потерялась
  if (want && !voices.some((v) => v.name === want)) {
    html += `<option value="${esc(want)}" selected>текущий: ${esc(want)} (нет в этом браузере)</option>`;
  }
  sel.innerHTML = html;
}

if ('speechSynthesis' in window) {
  // при поздней загрузке списка: выбранное пользователем в DOM — сохраняем,
  // иначе берём сохранённое из настроек (никогда — пустой DOM-дефолт)
  speechSynthesis.addEventListener?.('voiceschanged', () => fillTtsVoices($('#tts-voice')?.value || storedTtsVoice()));
}

$('#ov-copy').addEventListener('click', async () => {
  const v = $('#ov-url').value;
  try { await navigator.clipboard.writeText(v); toast('Скопировано ✅'); }
  catch { $('#ov-url').select(); toast('Выделила поле — Ctrl+C', true); }
});

// сбор ГЛОБАЛЬНОЙ части alerts (общий выключатель + TTS): один PUT на кнопках
// вкладки «Оверлей». Алерты конкретных событий сохраняются их карточками
// на вкладке «События». Пока настройки вкладки не загружены — null: не шлём
// ничего (иначе молча выключились бы ВСЕ алерты).
function collectAlerts() {
  if (!__overlayLoaded) return null;
  const alerts = { enabled: $('#ov-enabled').checked };
  const rate = Number($('#tts-rate').value);
  const volume = Number($('#tts-volume').value);
  alerts.tts = {
    enabled: $('#tts-enabled').checked,
    rate: Number.isFinite(rate) ? rate : 1,
    volume: Number.isFinite(volume) ? volume : 1, // 0 (тихо) валиден — не подменяем единицей
    voiceName: $('#tts-voice').value,
  };
  // список событий (Event List): size живёт своей жизнью, панель шлёт только enabled
  alerts.eventList = { enabled: $('#ov-eventlist').checked };
  return alerts;
}

$('#ov-save').addEventListener('click', async () => {
  const alerts = collectAlerts();
  if (!alerts) { toast('Настройки алертов ещё не загрузились — секунду…', true); return; }
  try {
    await putSettings({ alerts });
    toast('Алерты сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#tts-save').addEventListener('click', async () => {
  const alerts = collectAlerts();
  if (!alerts) { toast('Настройки ещё не загрузились — секунду…', true); return; }
  try {
    await putSettings({ alerts });
    toast('Озвучка сохранена ✅');
  } catch (e) { toast(e.message, true); }
});

// произнести тестовую фразу локально, без запроса к серверу
$('#tts-test').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) { toast('Этот браузер не умеет синтез речи', true); return; }
  try {
    const u = new SpeechSynthesisUtterance('Тест озвучки: Няшка оформила подписку на канал!');
    const name = $('#tts-voice').value;
    const v = (name ? ttsVoices().find((x) => x.name === name) : ttsVoices().find((x) => /^ru/i.test(String(x.lang || '')))) || null;
    if (v) { u.voice = v; u.lang = v.lang || 'ru-RU'; }
    const rate = Number($('#tts-rate').value);
    const volume = Number($('#tts-volume').value);
    u.rate = Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1;
    u.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    speechSynthesis.cancel(); // повторное нажатие не копит проверки
    speechSynthesis.speak(u);
  } catch { toast('Не удалось произнести — синтез речи недоступен', true); }
});

// ---------------- 📖 «Слово дня» (авто: самое частое слово чата) ----------------

let wodEd = { objects: [], enabled: false };
const WOD_TYPE_RU = { caption: '🏷 надпись', word: '🔤 слово', count: '🔢 счётчик', backdrop: '🟪 подложка', image: '🖼 картинка' };
const wodHist = [];
const wodRedoStack = [];
let wodLastPush = 0;
let wodClipboard = [];

function wodDefault() {
  // карточка в правом верхнем углу: подложка + «Слово дня:» + слово + счётчик справа
  return [
    { id: 'backdrop-0', type: 'backdrop', x: 1560, y: 24, w: 330, h: 120, opacity: 80, z: 1, color: '#0c0a19', radius: 18, rotate: 0, image: '' },
    { id: 'caption-0', type: 'caption', x: 1584, y: 38, w: 280, h: 26, opacity: 85, z: 3, color: '#ffffff', text: 'Слово дня:', fontSize: 14, radius: 0, rotate: 0 },
    { id: 'word-0', type: 'word', x: 1584, y: 70, w: 240, h: 46, opacity: 100, z: 4, color: '#ffffff', fontSize: 26, radius: 0, rotate: 0 },
    { id: 'count-0', type: 'count', x: 1800, y: 76, w: 70, h: 40, opacity: 90, z: 4, color: '#ffffff', fontSize: 18, radius: 12, rotate: 0 },
  ];
}

function wodNorm(raw) {
  const c = raw ?? {};
  const objects = (Array.isArray(c.objects) && c.objects.length
    ? c.objects.filter((o) => o && ['caption', 'word', 'count', 'backdrop', 'image'].includes(o.type))
    : wodDefault())
    .map((o, i) => ({
      id: o.id || `${o.type}-${i}`,
      type: o.type,
      x: Number(o.x) || 0, y: Number(o.y) || 0,
      w: Math.max(20, Number(o.w) || 300), h: Math.max(20, Number(o.h) || 120),
      opacity: Math.max(0, Math.min(100, Number(o.opacity ?? 100))),
      z: Math.max(0, Math.min(30, Number(o.z ?? 1))),
      image: String(o.image || ''),
      color: String(o.color || ''),
      text: String(o.text || ''),
      radius: Math.max(0, Number(o.radius) || 0),
      rotate: Math.max(-15, Math.min(15, Number(o.rotate) || 0)),
      fontSize: Math.max(10, Number(o.fontSize) || 22),
    }));
  return { enabled: Boolean(c.enabled), objects };
}

function wodK() { const s = $('#wod-stage'); return s ? s.clientWidth / 1920 : 0.25; }

function wodPush() {
  wodHist.push(JSON.stringify(wodEd.objects));
  if (wodHist.length > 60) wodHist.shift();
  wodRedoStack.length = 0;
  wodLastPush = Date.now();
}
function wodPushThrottled() { if (Date.now() - wodLastPush > 600) wodPush(); }
function wodUndo() {
  if (!wodHist.length) { toast('Отменять нечего'); return; }
  wodRedoStack.push(JSON.stringify(wodEd.objects));
  wodEd.objects = JSON.parse(wodHist.pop());
  wodSel = new Set();
  wodSelIdx = -1;
  wodRenderStage();
  wodRenderProps();
}
function wodRedo() {
  if (!wodRedoStack.length) { toast('Повторять нечего'); return; }
  wodHist.push(JSON.stringify(wodEd.objects));
  wodEd.objects = JSON.parse(wodRedoStack.pop());
  wodSel = new Set();
  wodSelIdx = -1;
  wodRenderStage();
  wodRenderProps();
}

let wodSel = new Set();
let wodSelIdx = 0;
let wodCurrent = { word: '', count: 0 };

function wodRenderStage() {
  const stage = $('#wod-stage');
  if (!stage) return;
  const k = wodK();
  const sorted = wodEd.objects.map((o, i) => ({ o, i })).sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
  stage.innerHTML = '';
  for (const { o, i } of sorted) {
    const div = document.createElement('div');
    div.className = `plp-obj plp-${o.type}${wodSel.has(i) ? ' sel' : ''}`;
    div.dataset.i = i;
    div.style.left = `calc(50% + ${Math.round((o.x - 960) * k)}px)`;
    div.style.top = `calc(50% + ${Math.round((o.y - 540) * k)}px)`;
    div.style.width = `${o.w * k}px`;
    div.style.height = `${o.h * k}px`;
    div.style.opacity = String(o.opacity / 100);
    div.style.borderRadius = `${o.radius * k}px`;
    div.style.transform = o.rotate ? `rotate(${o.rotate}deg)` : '';
    const fillText = o.type === 'caption'
      ? (o.text || 'Слово дня:')
      : o.type === 'word'
        ? (wodCurrent.word || 'пример')
        : o.type === 'count'
          ? `×${wodCurrent.count || 12}`
          : '';
    if (o.type === 'caption' || o.type === 'word' || o.type === 'count') {
      div.style.color = o.color || '#ffffff';
      div.style.fontSize = `${o.fontSize * k}px`;
      div.style.fontWeight = '700';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.overflow = 'hidden';
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = fillText;
    } else if (o.type === 'backdrop') {
      if (o.image) div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
      else div.style.backgroundColor = o.color || '#0c0a19';
    } else if (o.type === 'image' && o.image) {
      div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
    }
    if (wodSel.size === 1 && i === wodSelIdx) {
      const h = document.createElement('div');
      h.className = 'plp-resize';
      div.appendChild(h);
    }
    stage.appendChild(div);
  }
}

function wodSnap(nx, ny, self) {
  const others = wodEd.objects.filter((_, j) => !wodSel.has(j));
  const anchorsX = [nx, nx + self.w / 2, nx + self.w];
  const anchorsY = [ny, ny + self.h / 2, ny + self.h];
  const targetsX = [{ pos: 960, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.x, kind: 'obj' }, { pos: t.x + t.w / 2, kind: 'obj' }, { pos: t.x + t.w, kind: 'obj' }])];
  const targetsY = [{ pos: 540, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.y, kind: 'obj' }, { pos: t.y + t.h / 2, kind: 'obj' }, { pos: t.y + t.h, kind: 'obj' }])];
  let bestX = null;
  for (const a of anchorsX) for (const t of targetsX) {
    const d = t.pos - a;
    if (Math.abs(d) <= 14 && (!bestX || Math.abs(d) < Math.abs(bestX.shift))) bestX = { shift: d, target: t };
  }
  let bestY = null;
  for (const a of anchorsY) for (const t of targetsY) {
    const d = t.pos - a;
    if (Math.abs(d) <= 14 && (!bestY || Math.abs(d) < Math.abs(bestY.shift))) bestY = { shift: d, target: t };
  }
  return { x: nx + (bestX ? bestX.shift : 0), y: ny + (bestY ? bestY.shift : 0), guides: { v: bestX ? bestX.target : null, h: bestY ? bestY.target : null } };
}

function wodGuides({ v, h }) {
  $('#wod-guide-v')?.remove();
  $('#wod-guide-h')?.remove();
  if (!v && !h) return;
  const stage = $('#wod-stage');
  const k = wodK();
  if (v) {
    const g = document.createElement('div');
    g.id = 'wod-guide-v';
    g.className = `plp-guide plp-guide-v ${v.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.left = `${v.pos * k}px`;
    stage.appendChild(g);
  }
  if (h) {
    const g = document.createElement('div');
    g.id = 'wod-guide-h';
    g.className = `plp-guide plp-guide-h ${h.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.top = `${h.pos * k}px`;
    stage.appendChild(g);
  }
}

function wodRenderProps() {
  const chips = $('#wod-objects');
  const props = $('#wod-props');
  if (!chips || !props) return;
  chips.innerHTML = wodEd.objects.map((o, i) =>
    `<span class="chip${wodSel.has(i) ? ' sel' : ''}" data-i="${i}">${WOD_TYPE_RU[o.type] ?? o.type}${o.type === 'caption' && o.text ? ` · ${esc(o.text.slice(0, 14))}` : ''}</span>`
  ).join('');
  if (!wodSel.size) {
    props.innerHTML = '<p class="hint">Клик — выделить · shift+клик — несколько · рамка по пустому месту · ctrl+z/y/c/x/v. «Слово» и «Счётчик» заполняются данными чата сами.</p>';
    return;
  }
  if (wodSel.size > 1) {
    props.innerHTML = `
      <p class="hint">выделено: ${wodSel.size} — тащатся вместе</p>
      <div class="rp-row">
        <button class="act ghost" id="woded-zup">▲ слой</button>
        <button class="act ghost" id="woded-zdown">▼ слой</button>
        <button class="act ghost" id="woded-del">🗑 удалить выбранное</button>
      </div>`;
    $('#woded-zup').addEventListener('click', () => { for (const i of wodSel) wodEd.objects[i].z = Math.min(30, wodEd.objects[i].z + 1); wodRenderStage(); wodRenderProps(); });
    $('#woded-zdown').addEventListener('click', () => { for (const i of wodSel) wodEd.objects[i].z = Math.max(0, wodEd.objects[i].z - 1); wodRenderStage(); wodRenderProps(); });
    $('#woded-del').addEventListener('click', () => {
      wodPush();
      wodEd.objects = wodEd.objects.filter((_, i) => !wodSel.has(i));
      wodSel = new Set();
      wodSelIdx = -1;
      wodRenderStage();
      wodRenderProps();
    });
    return;
  }
  const o = wodEd.objects[wodSelIdx];
  if (!o) { props.innerHTML = ''; return; }
  const row = (label, html) => `<label>${label}<div class="am-sound-row">${html}</div></label>`;
  let html = `
    ${row(`ширина, px <span class="hint" id="woded-w-val">${o.w}</span>`, `<input type="range" id="woded-w" min="20" max="2000" value="${o.w}" />`)}
    ${row('прозрачность', `<input type="range" id="woded-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="weded-op-val-x">${o.opacity}%</span>`)}
    ${row('поворот', `<input type="range" id="woded-rot" min="-15" max="15" value="${o.rotate}" /><span class="hint" id="woded-rot-val">${o.rotate}°</span>`)}
    <div class="rp-row">
      <label class="hint">слой:</label>
      <button class="act ghost" id="woded-zup" title="поднять">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="woded-zdown" title="опустить">▼</button>`;
  if (o.type === 'caption' || o.type === 'word' || o.type === 'count') {
    html += row('текст', `<span class="hint">цвет</span><input type="color" id="woded-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="woded-fs" min="10" max="60" value="${o.fontSize}" style="width:56px" />`);
  }
  if (o.type === 'caption') {
    html += `<label>надпись <input type="text" id="woded-text" class="wide" maxlength="60" value="${esc(o.text || 'Слово дня:')}" /></label>`;
  }
  html += row('закругление', `<input type="number" id="woded-radius" min="0" max="120" value="${o.radius}" style="width:56px" />`);
  if (o.type === 'backdrop' || o.type === 'image') {
    html += o.type === 'backdrop' ? `<label>цвет <input type="color" id="woded-bcolor" value="${esc(o.color || '#0c0a19')}" style="width:46px" /></label>` : '';
    html += `<label>картинка <select id="woded-img"></select></label>
      <div class="am-sound-row"><input type="file" id="woded-img-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="woded-img-up">⬆</button></div>`;
  }
  html += `<button class="act ghost" id="woded-del">🗑 Удалить объект</button></div>`;
  props.innerHTML = html;

  $('#woded-w').addEventListener('pointerdown', wodPushThrottled);
  $('#woded-w').addEventListener('input', () => {
    o.w = Number($('#woded-w').value);
    $('#woded-w-val').textContent = String(o.w);
    wodRenderStage();
  });
  $('#woded-op').addEventListener('input', () => {
    o.opacity = Number($('#woded-op').value);
    $('#weded-op-val-x').textContent = `${o.opacity}%`;
    wodRenderStage();
  });
  $('#woded-rot').addEventListener('input', () => {
    o.rotate = Number($('#woded-rot').value);
    $('#woded-rot-val').textContent = `${o.rotate}°`;
    wodRenderStage();
  });
  $('#woded-zup').addEventListener('click', () => { o.z = Math.min(30, o.z + 1); wodRenderStage(); wodRenderProps(); });
  $('#woded-zdown').addEventListener('click', () => { o.z = Math.max(0, o.z - 1); wodRenderStage(); wodRenderProps(); });
  $('#woded-color')?.addEventListener('input', () => { o.color = $('#woded-color').value; wodRenderStage(); });
  $('#woded-fs')?.addEventListener('pointerdown', wodPushThrottled);
  $('#woded-fs')?.addEventListener('input', () => { o.fontSize = Number($('#woded-fs').value) || 22; wodRenderStage(); });
  $('#woded-text')?.addEventListener('input', () => { o.text = $('#woded-text').value; wodRenderStage(); wodRenderProps(); });
  $('#woded-radius')?.addEventListener('pointerdown', wodPushThrottled);
  $('#woded-radius')?.addEventListener('input', () => { o.radius = Number($('#woded-radius').value) || 0; wodRenderStage(); });
  $('#woded-bcolor')?.addEventListener('input', () => { o.color = $('#woded-bcolor').value; wodRenderStage(); });
  $('#woded-del').addEventListener('click', () => {
    wodPush();
    wodEd.objects.splice(wodSelIdx, 1);
    wodSelIdx = Math.max(-1, wodSelIdx - 1);
    wodSel = wodSelIdx >= 0 ? new Set([wodSelIdx]) : new Set();
    wodRenderStage();
    wodRenderProps();
  });

  const imgSel = $('#woded-img');
  if (imgSel) {
    api('/api/media').then(({ files }) => {
      const images = files.filter((f) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'apng'].includes(fileExt(f)));
      imgSel.innerHTML = ['<option value="">— не задано —</option>',
        ...images.map((f) => `<option value="${esc(f)}" ${o.image === f ? 'selected' : ''}>${esc(f)}</option>`)].join('');
    }).catch(() => {});
    imgSel.addEventListener('change', () => { wodPush(); o.image = imgSel.value; wodRenderStage(); wodRenderProps(); });
    $('#woded-img-up').addEventListener('click', async () => {
      const file = $('#woded-img-file')?.files?.[0];
      if (!file) { toast('Сначала выбери картинку', true); return; }
      const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || `HTTP ${r.status}`, true); return; }
      wodPush();
      o.image = file.name;
      toast('Картинка загружена ✅');
      wodRenderStage();
      wodRenderProps();
    });
  }
}

// drag/рамка/магнит — как у редакторов выше, своя сцена
(() => {
  const stage = $('#wod-stage');
  if (!stage) return;
  let mode = null;
  let idx = -1;
  let grabX = 0, grabY = 0;
  let starts = null;
  let band = null;
  let bandShift = false;
  let moved = false;
  let pendingGuides = null;

  const snapshot = () => {
    starts = new Map();
    for (const i of wodSel) starts.set(i, { ...wodEd.objects[i] });
  };

  stage.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.plp-resize');
    const obj = e.target.closest('.plp-obj');
    grabX = e.clientX; grabY = e.clientY;
    moved = false;
    stage.setPointerCapture?.(e.pointerId);
    if (!obj) {
      mode = 'band';
      bandShift = e.shiftKey;
      band = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
      wodGuides({ v: null, h: null });
      e.preventDefault();
      return;
    }
    idx = Number(obj.dataset.i);
    wodSelIdx = idx;
    if (e.shiftKey) {
      if (wodSel.has(idx)) wodSel.delete(idx);
      else wodSel.add(idx);
    } else if (!wodSel.has(idx)) {
      wodSel = new Set([idx]);
    }
    if (!wodSel.size) wodSel = new Set([idx]);
    wodSelIdx = wodSel.has(idx) ? idx : [...wodSel][0];
    mode = (handle && wodSel.size === 1) ? 'resize' : 'move';
    snapshot();
    wodPush();
    wodRenderStage();
    wodRenderProps();
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const k = wodK();
    moved = true;
    if (mode === 'band') {
      const r = stage.getBoundingClientRect();
      band = {
        x: Math.min(grabX, e.clientX) - r.left,
        y: Math.min(grabY, e.clientY) - r.top,
        w: Math.abs(e.clientX - grabX),
        h: Math.abs(e.clientY - grabY),
      };
      $('#wod-band')?.remove();
      const b = document.createElement('div');
      b.id = 'wod-band';
      b.style.left = `${band.x}px`;
      b.style.top = `${band.y}px`;
      b.style.width = `${band.w}px`;
      b.style.height = `${band.h}px`;
      stage.appendChild(b);
      return;
    }
    const dx = (e.clientX - grabX) / k;
    const dy = (e.clientY - grabY) / k;
    if (mode === 'move') {
      const anchor = starts.get(idx);
      if (!anchor) return;
      const snap = wodSnap(anchor.x + dx, anchor.y + dy, anchor);
      const shiftX = snap.x - (anchor.x + dx);
      const shiftY = snap.y - (anchor.y + dy);
      for (const [i, s] of starts) {
        const o = wodEd.objects[i];
        o.x = Math.round(Math.max(-500, Math.min(2500, s.x + dx + shiftX)));
        o.y = Math.round(Math.max(-500, Math.min(2500, s.y + dy + shiftY)));
      }
      pendingGuides = snap.guides;
    } else {
      const o = wodEd.objects[idx];
      const s = starts.get(idx);
      o.w = Math.round(Math.max(20, Math.min(2500, s.w + dx)));
      o.h = Math.round(Math.max(20, Math.min(2500, s.h + dy)));
    }
    wodRenderStage();
    wodRenderProps();
    if (pendingGuides) { wodGuides(pendingGuides); pendingGuides = null; }
  });

  const stop = () => {
    if (mode === 'band') {
      $('#wod-band')?.remove();
      if (!moved && !bandShift) {
        wodSel = new Set();
        wodSelIdx = -1;
      } else if (band && (band.w > 3 || band.h > 3)) {
        wodSel = new Set();
        const k = wodK();
        for (const [i, o] of wodEd.objects.entries()) {
          const r = { x: o.x * k, y: o.y * k, w: o.w * k, h: o.h * k };
          if (r.x < band.x + band.w && r.x + r.w > band.x && r.y < band.y + band.h && r.y + r.h > band.y) wodSel.add(i);
        }
        if (wodSel.size) wodSelIdx = [...wodSel].at(-1);
      }
      wodRenderStage();
      wodRenderProps();
    }
    mode = null;
    starts = null;
    band = null;
    wodGuides({ v: null, h: null });
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
})();

$('#wod-objects').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-i]');
  if (!chip) return;
  const i = Number(chip.dataset.i);
  if (e.shiftKey) {
    if (wodSel.has(i)) wodSel.delete(i);
    else wodSel.add(i);
  } else wodSel = new Set([i]);
  wodSelIdx = i;
  wodRenderStage();
  wodRenderProps();
});

$('#wod-props').addEventListener('pointerdown', wodPushThrottled);

function wodCopy(cut = false) {
  if (!wodSel.size) { toast('Сначала выдели объект(ы)', true); return; }
  wodClipboard = [...wodSel].map((i) => JSON.parse(JSON.stringify(wodEd.objects[i])));
  if (cut) {
    wodPush();
    wodEd.objects = wodEd.objects.filter((_, i) => !wodSel.has(i));
    wodSel = new Set();
    wodSelIdx = -1;
    wodRenderStage();
    wodRenderProps();
    toast(`Вырезано: ${wodClipboard.length}`);
  } else toast(`Скопировано: ${wodClipboard.length}`);
}
function wodPaste() {
  if (!wodClipboard?.length) { toast('Буфер пуст', true); return; }
  wodPush();
  const pasted = [];
  for (const [n, o] of wodClipboard.entries()) {
    const c = { ...o, x: o.x + 30, y: o.y + 30 };
    c.id = `${c.type}-${Date.now()}-${n}`;
    wodEd.objects.push(c);
    pasted.push(wodEd.objects.length - 1);
  }
  wodSel = new Set(pasted);
  wodSelIdx = pasted.at(-1);
  wodRenderStage();
  wodRenderProps();
  toast(`Вставлено: ${pasted.length}`);
}

document.addEventListener('keydown', (e) => {
  if (!$('#tab-overlay')?.classList.contains('active')) return;
  if (e.target.closest('input, textarea, select')) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); wodUndo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); wodRedo(); }
  else if (key === 'c') { e.preventDefault(); wodCopy(); }
  else if (key === 'x') { e.preventDefault(); wodCopy(true); }
  else if (key === 'v') { e.preventDefault(); wodPaste(); }
});

$('#wod-widget-add').addEventListener('click', () => $('#wod-image-file').click());
$('#wod-image-file').addEventListener('change', async () => {
  const file = $('#wod-image-file')?.files?.[0];
  if (!file) return;
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const zMax = Math.max(0, ...wodEd.objects.map((o) => o.z));
    wodPush();
    wodEd.objects.push({ id: `image-${Date.now()}`, type: 'image', x: 1500, y: 200, w: 340, h: 220, opacity: 100, z: zMax + 1, image: file.name, radius: 0, rotate: 0 });
    wodSelIdx = wodEd.objects.length - 1;
    wodSel = new Set([wodSelIdx]);
    $('#wod-image-file').value = '';
    wodRenderStage();
    wodRenderProps();
    toast('Элемент добавлен 🖼');
  } catch (e) { toast(e.message, true); }
});
$('#wod-widget-reset').addEventListener('click', () => {
  wodPush();
  wodEd.objects = wodDefault();
  wodSelIdx = 0;
  wodSel = new Set([0]);
  wodRenderStage();
  wodRenderProps();
  toast('Дефолтная раскладка (не забудь сохранить)');
});

$('#wod-save').addEventListener('click', async () => {
  try {
    await putSettings({ wordOfDay: { enabled: $('#wod-enabled').checked, objects: wodEd.objects } });
    toast('«Слово дня» сохранено ✅');
    loadWordOfDayCurrent();
  } catch (e) { toast(e.message, true); }
});

async function loadWordOfDayCurrent() {
  try {
    const { wod } = await api('/api/wordofday');
    wodCurrent = { word: wod.word || '', count: Number(wod.count) || 0 };
    $('#wod-current').textContent = wod.word || '— пока пусто —';
    $('#wod-count').textContent = wod.word ? `· написали ${wod.count} раз` : '';
    wodRenderStage();
  } catch {}
}

async function loadWordOfDay() {
  const st = await api('/api/settings');
  wodEd = wodNorm(st.wordOfDay);
  wodEd.enabled = Boolean(st.wordOfDay?.enabled);
  $('#wod-enabled').checked = wodEd.enabled;
  wodSelIdx = 0;
  wodSel = new Set(wodEd.objects.length ? [0] : []);
  await loadWordOfDayCurrent();
  wodRenderStage();
  wodRenderProps();
}
loadWordOfDay().catch(() => {});

$('#wod-refresh').addEventListener('click', () => loadWordOfDayCurrent().catch(() => {}));

$('#wod-reset').addEventListener('click', async () => {
  if (!confirm('Обнулить статистику слов? «Слово дня» выберется заново из новых сообщений.')) return;
  try {
    await api('/api/actions/wordofdayreset', { method: 'POST', body: '{}' });
    toast('Статистика обнулена');
    loadWordOfDayCurrent();
  } catch (e) { toast(e.message, true); }
});

// ---------------- музыка (заказы YouTube) ----------------

// YouTube-плеер в панели: превью без звука, состояние приезжает по SSE (та же шина, что у OBS-плеера)
let sgYt = null;
let sgYtWanted = null; // видео, которое хотим показать (пока API грузится)
let sgYtBooted = false;
let __songsPaused = false;

function sgEnsureYt() {
  if (sgYtBooted) return;
  sgYtBooted = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = () => {
    sgYt = new YT.Player('sg-player', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          try { sgYt.mute(); } catch {}
          if (sgYtWanted) sgLoadVideo(sgYtWanted);
        },
      },
    });
  };
}

function sgLoadVideo(id) {
  sgYtWanted = id;
  if (!sgYt || !sgYt.loadVideoById) return;
  try {
    if (sgYt.getVideoData?.()?.video_id !== id) {
      sgYt.loadVideoById(id);
      sgYt.mute(); // в панели только превью — звук живёт в OBS-плеере
    }
  } catch {}
}

function sgPauseVideo() { try { sgYt?.pauseVideo?.(); } catch {} }
function sgPlayVideo() { try { sgYt?.playVideo?.(); } catch {} }
function sgStopVideo() {
  try { sgYt?.stopVideo?.(); sgYtWanted = null; sgYt?.mute?.(); } catch {} // после теста превью снова без звука
}

// применяется состояние плеера/очереди к вкладке (из /api/songs или живьём из SSE)
let __songsTesting = false;
function __sgApplyState(st) {
  if (!st) return;
  __songsPaused = Boolean(st.paused);
  __songsTesting = false; // «sr»-событие = реальный трек, теста больше нет
  $('#sg-current').innerHTML = st.current
    ? `▶ <b>${esc(st.current.title)}</b> — заказал ${esc(st.current.byName || st.current.by)}${st.paused ? ' · <b>на паузе</b>' : ''}`
    : 'Ничего не играет';
  $('#sg-body').innerHTML = (st.queue ?? []).map((song, i) => `
    <tr data-index="${i}">
      <td>${i + 1}</td>
      <td class="cellresp"><span class="sg-title-link" data-id="${esc(song.id)}" title="клик — скопировать ссылку">${esc(song.title)}</span></td>
      <td class="cellname">${esc(song.byName || song.by)}</td>
      <td>
        <button class="act ghost sg-bl" data-id="${esc(song.id)}" data-title="${esc(song.title)}" title="в чёрный список (и убрать из очереди)">🚫</button>
        <button class="act ghost sg-remove" title="убрать из очереди">🗑</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">Очередь пуста</td></tr>';

  // кнопка паузы меняет вид: играет → «⏸ Пауза» (ghost), на паузе → «▶ Продолжить» (акцент)
  const toggle = $('#sg-toggle');
  if (toggle) {
    toggle.textContent = __songsPaused ? '▶ Продолжить' : '⏸ Пауза';
    toggle.classList.toggle('ghost', !__songsPaused);
  }

  // громкость: обновляем, если юзер не тянет ползунок прямо сейчас
  const vol = $('#sg-volume');
  if (vol && document.activeElement !== vol) {
    vol.value = st.volume ?? 60;
    $('#sg-volume-val').textContent = String(st.volume ?? 60);
  }

  // превью-плеер повторяет состояние OBS-плеера (обычные треки — без звука; тест включает его сам)
  sgEnsureYt();
  try { sgYt?.mute?.(); } catch {}
  const placeholder = $('#sg-player-ph');
  if (st.current?.id) {
    if (placeholder) placeholder.classList.add('hidden');
    sgLoadVideo(st.current.id);
    if (__songsPaused) sgPauseVideo();
  } else {
    if (placeholder && !__songsTesting) placeholder.classList.remove('hidden');
    sgStopVideo();
  }
}

// живое зеркало: слушаем ту же SSE-шину, что и оверлей/плеер в OBS
const sgFeed = new EventSource('/overlay/feed');
sgFeed.onmessage = (m) => {
  try {
    const ev = JSON.parse(m.data);
    if (ev?.kind === 'srtest') {
      // команды плеера рулят и тестом: пауза/прод/стоп приходят сюда же
      if (ev.op === 'pause') { __songsPaused = true; sgPauseVideo(); }
      else if (ev.op === 'resume') { __songsPaused = false; sgPlayVideo(); }
      else if (ev.op === 'stop') { __songsTesting = false; sgStopVideo(); $('#sg-player-ph')?.classList.remove('hidden'); }
      else if (ev.op === 'play') { __songsTesting = true; sgPlayTest(ev); const ph = $('#sg-player-ph'); if (ph) ph.classList.add('hidden'); }
      return;
    }
    if (ev?.kind === 'sr') __sgApplyState(ev);
  } catch {}
};

// тест плеера: трек играет ЗДЕСЬ со звуком (громкость слайдера) и в OBS-плеере
function sgPlayTest(ev) {
  sgEnsureYt();
  if (ev?.id) sgLoadVideo(ev.id);
  try {
    if (sgYt?.unMute) {
      sgYt.unMute();
      sgYt.setVolume(Math.max(0, Math.min(100, Number($('#sg-volume')?.value) || 60)));
      sgYt.playVideo();
    }
  } catch {}
}

async function loadSongsTab() {
  const st = await api('/api/songs');
  const s = (await api('/api/settings')).songs ?? {};
  $('#music-url').textContent = `${location.origin}/music`;
  $('#music-url-field').value = `${location.origin}/music`;
  $('#music-open').href = `${location.origin}/music`;
  $('#sg-enabled').checked = Boolean(s.enabled);
  // длина — в минутах в панели, в секундах на сервере
  $('#sg-maxlen-min').value = Math.round((s.maxLenSec ?? 600) / 60);
  $('#sg-minviews').value = s.minViews ?? 0;
  $('#sg-template').value = s.nowTemplate ?? '♪ {title} — заказал {by}';
  // правила заказов
  $('#sg-mode').value = s.requestMode ?? 'command';
  $('#sg-reward-name').value = s.rewardName ?? '';
  $('#sg-cmdname').value = s.commandName ?? 'ср';
  $('#sg-refund-reject').checked = s.refundOnReject !== false;
  $('#sg-refund-limit').checked = s.refundOnLimit !== false;
  $('#sg-cd').value = Math.round((s.commandCooldown ?? 0) / 60);
  $('#sg-peruser').value = s.perUser ?? 2;
  $('#sg-allowusers').value = (s.allowUsers ?? []).join(', ');
  document.querySelectorAll('.sg-role').forEach((cb) => { cb.checked = (s.allow ?? []).includes(cb.value); });
  sgSyncModeRows();
  renderBlacklist(s.blacklist ?? []);
  plpLoad(s.playerCfg, st);
  __sgApplyState(st);
}

/** видимость полей зависит от способа заказов: награда — имя, команда — кулдаун */
function sgSyncModeRows() {
  const mode = $('#sg-mode').value;
  $('#sg-reward-row').classList.toggle('hidden', mode !== 'reward');
  $('#sg-cd-row').classList.toggle('hidden', mode !== 'command');
}
$('#sg-mode').addEventListener('change', sgSyncModeRows);

/** список чёрного списка: просмотр + копия ссылки + убрать из ЧС */
function renderBlacklist(list) {
  const box = $('#sg-bl-list');
  if (!box) return;
  box.innerHTML = (list || []).map((x) => `
    <div class="chips" style="margin-bottom:6px">
      <span class="chip" title="клик — скопировать ссылку" style="cursor:pointer" data-bl-copy="${esc(x.id)}">🚫 ${esc(x.title || `youtu.be/${x.id}`)}</span>
      <button class="act ghost bl-del" data-id="${esc(x.id)}" title="убрать из чёрного списка">✕</button>
    </div>`).join('') || '<p class="hint">Пусто — заблокированных треков нет. Кнопка 🚫 в очереди добавляет их сюда одним кликом.</p>';
}

$('#sg-bl-list').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-bl-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(`https://youtu.be/${copy.dataset.blCopy}`); toast('Ссылка скопирована'); } catch {}
    return;
  }
  const del = e.target.closest('.bl-del');
  if (!del) return;
  try {
    await api('/api/songs', { method: 'POST', body: JSON.stringify({ op: 'blacklist-remove', id: del.dataset.id }) });
    toast('Убрано из чёрного списка');
    loadSongsTab();
  } catch (err) { toast(err.message, true); }
});

// вручную вставить ссылку в чёрный список
$('#sg-bl-add-btn').addEventListener('click', async () => {
  const url = $('#sg-bl-add').value.trim();
  if (!url) { toast('Вставь ссылку YouTube', true); return; }
  try {
    const r = await api('/api/songs', { method: 'POST', body: JSON.stringify({ op: 'blacklist-add', url }) });
    if (r.error) { toast(r.error, true); return; }
    $('#sg-bl-add').value = '';
    toast('Трек заблокирован 🚫');
    loadSongsTab();
  } catch (err) { toast(err.message, true); }
});
$('#sg-bl-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#sg-bl-add-btn').click(); });

$('#music-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#music-url-field').value); toast('Скопировано ✅'); }
  catch { $('#music-url-field').select(); toast('Выделила поле — Ctrl+C', true); }
});

$('#sg-save').addEventListener('click', async () => {
  try {
    await putSettings({
      songs: {
        enabled: $('#sg-enabled').checked,
        maxLenSec: Math.round((Number($('#sg-maxlen-min').value) || 10) * 60),
        minViews: Math.max(0, Number($('#sg-minviews').value) || 0),
        volume: Number($('#sg-volume').value) || 0,
        nowTemplate: $('#sg-template').value,
      },
    });
    toast('Настройки музыки сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

// правила заказов: способ, кулдаун, лимиты, доступ
$('#sg-order-save').addEventListener('click', async () => {
  const allow = [...document.querySelectorAll('.sg-role:checked')].map((cb) => cb.value);
  if (allow.includes('everyone')) allow.length = 0; // «все» = пустой список
  const allowUsers = $('#sg-allowusers').value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await putSettings({
      songs: {
        requestMode: $('#sg-mode').value,
        rewardName: $('#sg-reward-name').value.trim(),
        commandName: $('#sg-cmdname').value.trim(),
        refundOnReject: $('#sg-refund-reject').checked,
        refundOnLimit: $('#sg-refund-limit').checked,
        commandCooldown: Math.round((Number($('#sg-cd').value) || 0) * 60),
        perUser: Math.max(1, Number($('#sg-peruser').value) || 2),
        allow,
        allowUsers,
      },
    });
    toast('Правила заказов сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

// громкость: слайдер применяется сразу (дебаунс), без «Сохранить»
let sgVolTimer = null;
$('#sg-volume').addEventListener('input', () => {
  $('#sg-volume-val').textContent = $('#sg-volume').value;
  clearTimeout(sgVolTimer);
  sgVolTimer = setTimeout(async () => {
    try {
      await putSettings({ songs: { volume: Math.max(0, Math.min(100, Number($('#sg-volume').value) || 0)) } });
      toast(`Громкость плеера: ${$('#sg-volume').value}%`);
    } catch (e) { toast(e.message, true); }
  }, 500);
});

$('#sg-skip').addEventListener('click', async () => {
  try { await api('/api/actions/srnext', { method: 'POST', body: '{}' }); toast('Трек скипнут ⏭'); }
  catch (e) { toast(e.message, true); }
});

// пауза/продолжить — одна кнопка, вид зависит от состояния
$('#sg-toggle').addEventListener('click', () => {
  const op = __songsPaused ? 'resume' : 'pause';
  api('/api/actions/srcontrol', { method: 'POST', body: JSON.stringify({ op }) })
    .then(() => {
      __songsPaused = op === 'pause';
      // кнопку переворачиваем сразу; полное состояние приедет по SSE
      const toggle = $('#sg-toggle');
      toggle.textContent = __songsPaused ? '▶ Продолжить' : '⏸ Пауза';
      toggle.classList.toggle('ghost', !__songsPaused);
    })
    .catch((e) => toast(e.message, true));
});

$('#sg-stop').addEventListener('click', () => {
  if (!confirm('Остановить музыку и очистить очередь?')) return;
  api('/api/actions/srcontrol', { method: 'POST', body: JSON.stringify({ op: 'stop' }) }).then(() => loadSongsTab()).catch((e) => toast(e.message, true));
});
$('#sg-refresh').addEventListener('click', () => loadSongsTab().catch(() => {}));

// 🧪 тест плеера: первый раз в жизни — сюрприз 👀, дальше Bad Apple
$('#sg-test').addEventListener('click', async () => {
  try {
    const r = await api('/api/songs', { method: 'POST', body: JSON.stringify({ op: 'test' }) });
    if (r.error) { toast(r.error, true); return; }
    toast(r.first ? 'Тест запущен — смотри плеер 👀' : `Тест: ${r.title} 🍎`);
  } catch (e) { toast(e.message, true); }
});

// ---------------- 📐 редактор раскладки OBS-плеера (слои объектов) ----------------
// всё в px сцены OBS 1920×1080; превью честно масштабируется: k = width/1920

let plp = { objects: [], sel: 0, selSet: new Set(), clipboard: [] }; // selSet — мультивыделение (shift+клик); sel — последний кликнутый

// ---------- история: ctrl+z / ctrl+y ----------
const plpHist = [];
const plpRedoStack = [];
let plpLastPush = 0;

function plpPush() {
  plpHist.push(JSON.stringify(plp.objects));
  if (plpHist.length > 60) plpHist.shift();
  plpRedoStack.length = 0;
  plpLastPush = Date.now();
}
function plpPushThrottled() {
  if (Date.now() - plpLastPush > 600) plpPush(); // один снимок на «жест» (ползунок тащат сотней input-ов)
}
function plpUndo() {
  if (!plpHist.length) { toast('Отменять нечего'); return; }
  plpRedoStack.push(JSON.stringify(plp.objects));
  plp.objects = JSON.parse(plpHist.pop());
  plp.selSet = new Set();
  plp.sel = -1;
  plpRenderStage();
  plpRenderProps();
}
function plpRedo() {
  if (!plpRedoStack.length) { toast('Повторять нечего'); return; }
  plpHist.push(JSON.stringify(plp.objects));
  plp.objects = JSON.parse(plpRedoStack.pop());
  plp.selSet = new Set();
  plp.sel = -1;
  plpRenderStage();
  plpRenderProps();
}

const PLP_TYPE_RU = { video: '📺 видео', marquee: '🎬 строка', backdrop: '🟪 подложка', image: '🖼 картинка' };

function plpNorm(raw) {
  const c = raw ?? {};
  if (Array.isArray(c.objects) && c.objects.length) {
    return {
      v: 2,
      objects: c.objects
        .filter((o) => o && ['video', 'marquee', 'backdrop', 'image'].includes(o.type))
        .map((o, i) => ({
          id: o.id || `${o.type}-${i}`,
          type: o.type,
          x: Number(o.x) || 0, y: Number(o.y) || 0,
          w: Math.max(20, Number(o.w) || 400), h: Math.max(20, Number(o.h) || 300),
          opacity: Math.max(0, Math.min(100, Number(o.opacity ?? 100))),
          z: Math.max(0, Math.min(30, Number(o.z ?? 1))),
          hideOnIdle: Boolean(o.hideOnIdle),
          image: String(o.image || ''),
          color: String(o.color || ''),
          radius: Math.max(0, Number(o.radius) || 0),
          fontSize: Math.max(10, Number(o.fontSize) || 22),
          speed: Math.max(5, Number(o.speed) || 30),
        })),
    };
  }
  // пусто/легаси → дефолт: микро-экран по центру + строка ниже
  const W = 320, H = 180;
  return {
    v: 2,
    objects: [
      { type: 'video', x: (1920 - W) / 2, y: (1080 - H) / 2, w: W, h: H, opacity: 100, z: 3, hideOnIdle: true },
      { type: 'marquee', x: 960 - 224, y: (1080 + H) / 2 + 12, w: 448, h: 38, opacity: 100, z: 4, hideOnIdle: true, color: '#ffffff', fontSize: 22, speed: 30 },
    ],
  };
}

function plpK() { const s = $('#plp-stage'); return s ? s.clientWidth / 1920 : 0.25; }

function plpMarqueeText() {
  const cur = window.__songsState?.current;
  if (cur) return (window.__settings?.songs?.nowTemplate || '♪ {title} — заказал {by}')
    .replaceAll('{title}', cur.title || '')
    .replaceAll('{by}', cur.byName || cur.by || '')
    .replaceAll('{author}', cur.author || '');
  return '♪ так будет выглядеть бегущая строка — заказал кто-то';
}

function plpRenderStage() {
  const stage = $('#plp-stage');
  if (!stage) return;
  const k = plpK();
  const sorted = plp.objects.map((o, i) => ({ o, i })).sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
  stage.innerHTML = '';
  for (const { o, i } of sorted) {
    const div = document.createElement('div');
    div.className = `plp-obj plp-${o.type}${plp.selSet.has(i) ? ' sel' : ''}`;
    div.dataset.i = i;
    div.style.left = `${o.x * k}px`;
    div.style.top = `${o.y * k}px`;
    div.style.width = `${o.w * k}px`;
    div.style.height = `${o.h * k}px`;
    div.style.opacity = String(o.opacity / 100);
    if (o.type === 'video') {
      div.style.borderRadius = `${Math.max(6, Math.round(o.w * 0.055)) * k}px`;
      const cur = window.__songsState?.current;
      div.style.backgroundImage = cur?.id ? `url(https://i.ytimg.com/vi/${cur.id}/hqdefault.jpg)` : '';
    } else if (o.type === 'marquee') {
      div.style.color = o.color || '#ffffff';
      div.style.fontSize = `${o.fontSize * k}px`;
      const t = plpMarqueeText();
      div.innerHTML = `<div class="pl-track" style="animation-duration:${o.speed}s"><span>${esc(t)}</span><span>${esc(t)}</span></div>`;
    } else if (o.type === 'backdrop') {
      div.style.borderRadius = `${o.radius * k}px`;
      if (o.image) {
        div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
      } else {
        const m = String(o.color || '#0c0a19').match(/^#?([0-9a-f]{6})$/i);
        div.style.backgroundColor = m
          ? `rgba(${parseInt(m[1].slice(0, 2), 16)}, ${parseInt(m[1].slice(2, 4), 16)}, ${parseInt(m[1].slice(4, 6), 16)}, 1)`
          : (o.color || '#0c0a19');
        div.style.opacity = String(o.opacity / 100);
      }
    } else if (o.type === 'image') {
      div.style.borderRadius = `${o.radius * k}px`;
      if (o.image) div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
    }
    if (plp.selSet.size === 1 && i === plp.sel) {
      const h = document.createElement('div');
      h.className = 'plp-resize';
      div.appendChild(h);
    }
    stage.appendChild(div);
  }
}

// ---------- «магнит»: прилипание центров/краёв к осям и к другим объектам ----------
const PLP_SNAP = 14; // зона магнита, px сцены

function plpSnap(nx, ny, self) {
  const others = plp.objects.filter((_, j) => !plp.selSet.has(j));
  const anchorsX = [nx, nx + self.w / 2, nx + self.w]; // левый/центр/правый край
  const anchorsY = [ny, ny + self.h / 2, ny + self.h];
  const targetsX = [{ pos: 960, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.x, kind: 'obj' }, { pos: t.x + t.w / 2, kind: 'obj' }, { pos: t.x + t.w, kind: 'obj' }])]; // ось сцены + края/центры других
  const targetsY = [{ pos: 540, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.y, kind: 'obj' }, { pos: t.y + t.h / 2, kind: 'obj' }, { pos: t.y + t.h, kind: 'obj' }])];
  let bestX = null;
  for (const a of anchorsX) for (const t of targetsX) {
    const d = t.pos - a;
    if (Math.abs(d) <= PLP_SNAP && (!bestX || Math.abs(d) < Math.abs(bestX.shift))) bestX = { shift: d, target: t };
  }
  let bestY = null;
  for (const a of anchorsY) for (const t of targetsY) {
    const d = t.pos - a;
    if (Math.abs(d) <= PLP_SNAP && (!bestY || Math.abs(d) < Math.abs(bestY.shift))) bestY = { shift: d, target: t };
  }
  return {
    x: nx + (bestX ? bestX.shift : 0),
    y: ny + (bestY ? bestY.shift : 0),
    guides: { v: bestX ? bestX.target : null, h: bestY ? bestY.target : null },
  };
}

// направляющие: синий пунктир — прилипание к оси сцены, оранжевый — к объекту.
// рисуются ТОЛЬКО когда реально прилипли
function plpGuides({ v, h }) {
  $('#plp-guide-v')?.remove();
  $('#plp-guide-h')?.remove();
  if (!v && !h) return;
  const stage = $('#plp-stage');
  const k = plpK();
  if (v) {
    const g = document.createElement('div');
    g.id = 'plp-guide-v';
    g.className = `plp-guide plp-guide-v ${v.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.left = `${v.pos * k}px`;
    stage.appendChild(g);
  }
  if (h) {
    const g = document.createElement('div');
    g.id = 'plp-guide-h';
    g.className = `plp-guide plp-guide-h ${h.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.top = `${h.pos * k}px`;
    stage.appendChild(g);
  }
}

// ---------- drag/resize/рамка мышкой прямо в превью ----------
(() => {
  const stage = $('#plp-stage');
  let mode = null; // 'move' | 'resize' | 'band' (рамка как на рабочем столе)
  let idx = -1; // объект, за который взялись (якорь для магнита)
  let grabX = 0, grabY = 0;
  let starts = null; // снимок позиций ВЫДЕЛЕННЫХ (группа тащится целиком)
  let band = null; // rect рамки в координатах превью
  let bandShift = false;
  let moved = false;
  let pendingGuides = null; // направляющие рисуем после перерисовки превью

  function snapshot() {
    starts = new Map();
    for (const i of plp.selSet) starts.set(i, { ...plp.objects[i] });
  }

  stage.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.plp-resize');
    const obj = e.target.closest('.plp-obj');
    grabX = e.clientX; grabY = e.clientY;
    moved = false;
    stage.setPointerCapture?.(e.pointerId);

    if (!obj) {
      // пустое место: короткий клик очистит выделение, потянешь — рамка «как в винде»
      mode = 'band';
      bandShift = e.shiftKey;
      band = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
      plpGuides({ v: null, h: null });
      e.preventDefault();
      return;
    }

    idx = Number(obj.dataset.i);
    plp.sel = idx;
    if (e.shiftKey) {
      // шифт+клик: добавить/убрать в выделение без очистки
      if (plp.selSet.has(idx)) plp.selSet.delete(idx);
      else plp.selSet.add(idx);
    } else if (!plp.selSet.has(idx)) {
      plp.selSet = new Set([idx]);
    }
    if (!plp.selSet.size) plp.selSet = new Set([idx]);
    plp.sel = plp.selSet.has(idx) ? idx : [...plp.selSet][0];

    if (handle && plp.selSet.size === 1) mode = 'resize';
    else mode = 'move';
    snapshot();
    plpPush(); // снимок до жеста — для ctrl+z
    plpRenderStage();
    plpRenderProps();
    e.preventDefault();
  });

  function bandRect(e) {
    const r = stage.getBoundingClientRect();
    const x0 = Math.min(grabX, e.clientX) - r.left;
    const y0 = Math.min(grabY, e.clientY) - r.top;
    const x1 = Math.max(grabX, e.clientX) - r.left;
    const y1 = Math.max(grabY, e.clientY) - r.top;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  stage.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const k = plpK();
    moved = true;

    if (mode === 'band') {
      band = bandRect(e);
      $('#plp-band')?.remove();
      const b = document.createElement('div');
      b.id = 'plp-band';
      b.style.left = `${band.x}px`;
      b.style.top = `${band.y}px`;
      b.style.width = `${band.w}px`;
      b.style.height = `${band.h}px`;
      stage.appendChild(b);
      return;
    }

    const dx = (e.clientX - grabX) / k;
    const dy = (e.clientY - grabY) / k;

    if (mode === 'move') {
      const anchor = starts.get(idx);
      if (!anchor) return;
      const rawX = anchor.x + dx;
      const rawY = anchor.y + dy;
      const snap = plpSnap(rawX, rawY, anchor); // магнит считаем по якорю
      pendingGuides = snap.guides; // нарисуем ПОСЛЕ перерисовки, иначе innerHTML их сотрёт
      const shiftX = snap.x - rawX; // прилипание переносим всей группе — она едет монолитно
      const shiftY = snap.y - rawY;
      for (const [i, s] of starts) {
        const o = plp.objects[i];
        o.x = Math.round(Math.max(-500, Math.min(2500, s.x + dx + shiftX)));
        o.y = Math.round(Math.max(-500, Math.min(2500, s.y + dy + shiftY)));
      }
    } else {
      const o = plp.objects[idx];
      const s = starts.get(idx);
      o.w = Math.round(Math.max(20, Math.min(2500, s.w + dx)));
      if (o.type === 'video') o.h = Math.round(o.w * 9 / 16); // форма не меняется
      else o.h = Math.round(Math.max(20, Math.min(2500, s.h + dy)));
      if (o.type === 'marquee') o.h = o.fontSize + 16;
    }
    plpRenderStage();
    plpRenderProps();
    if (pendingGuides) { plpGuides(pendingGuides); pendingGuides = null; }
  });

  const stop = (e) => {
    if (mode === 'band') {
      $('#plp-band')?.remove();
      // клик по пустому (без движения) — снять выделение; потянули — выбрать рамкой
      if (!moved && !bandShift) {
        plp.selSet = new Set();
        plp.sel = -1;
      } else if (band && (band.w > 3 || band.h > 3)) {
        if (!bandShift) plp.selSet = new Set();
        const k = plpK();
        for (const [i, o] of plp.objects.entries()) {
          const r = { x: o.x * k, y: o.y * k, w: o.w * k, h: o.h * k };
          if (r.x < band.x + band.w && r.x + r.w > band.x && r.y < band.y + band.h && r.y + r.h > band.y) plp.selSet.add(i);
        }
        if (plp.selSet.size) plp.sel = [...plp.selSet].at(-1);
      }
      plpRenderStage();
      plpRenderProps();
    }
    mode = null;
    starts = null;
    band = null;
    plpGuides({ v: null, h: null });
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
})();

// любые контролы свойств: снимок истории при первом касании (жест=одноundo)
$('#plp-props').addEventListener('pointerdown', plpPushThrottled);

// ---------- свойства выделенного (одного или группы) ----------
function plpRenderProps() {
  const chips = $('#plp-objects');
  const props = $('#plp-props');
  if (!chips || !props) return;
  chips.innerHTML = plp.objects.map((o, i) =>
    `<span class="chip${plp.selSet.has(i) ? ' sel' : ''}" data-i="${i}">${PLP_TYPE_RU[o.type] ?? o.type}${o.type === 'image' && o.image ? ` · ${esc(o.image)}` : ''}</span>`
  ).join('') || '<span class="hint">объектов нет</span>';

  if (!plp.selSet.size) {
    props.innerHTML = '<p class="hint">Клик — выделить объект · shift+клик — несколько · потяни по пустому месту — рамка выделения, как на рабочем столе.<br>Хоткеи: <b>ctrl+z</b> отменить · <b>ctrl+y</b> вернуть · <b>ctrl+c/x/v</b> копировать/вырезать/вставить.</p>';
    return;
  }

  // группа: общие поля без деталей
  if (plp.selSet.size > 1) {
    props.innerHTML = `
      <p class="hint">выделено: ${plp.selSet.size} — тащатся вместе, магнит считается по тому, за который взялся</p>
      <label>прозрачность всем
        <div class="am-sound-row"><input type="range" id="plp-op" min="0" max="100" value="${plp.objects[plp.sel]?.opacity ?? 100}" /><span class="hint" id="plp-op-val">${plp.objects[plp.sel]?.opacity ?? 100}%</span></div>
      </label>
      <div class="rp-row">
        <button class="act ghost" id="plp-zup" title="поднять всем">▲ слой</button>
        <button class="act ghost" id="plp-zdown" title="опустить всем">▼ слой</button>
        <button class="act ghost" id="plp-del">🗑 удалить выбранное</button>
      </div>`;
    $('#plp-op').addEventListener('input', () => {
      const v = Number($('#plp-op').value);
      $('#plp-op-val').textContent = `${v}%`;
      for (const i of plp.selSet) plp.objects[i].opacity = v;
      plpRenderStage();
    });
    $('#plp-zup').addEventListener('click', () => { for (const i of plp.selSet) plp.objects[i].z = Math.min(30, plp.objects[i].z + 1); plpRenderStage(); plpRenderProps(); });
    $('#plp-zdown').addEventListener('click', () => { for (const i of plp.selSet) plp.objects[i].z = Math.max(0, plp.objects[i].z - 1); plpRenderStage(); plpRenderProps(); });
    $('#plp-del').addEventListener('click', () => {
      plpPush();
      plp.objects = plp.objects.filter((_, i) => !plp.selSet.has(i));
      plp.selSet = new Set();
      plp.sel = -1;
      plpRenderStage();
      plpRenderProps();
    });
    return;
  }

  const o = plp.objects[plp.sel];
  if (!o) { props.innerHTML = ''; return; }

  const row = (label, html) => `<label>${label}<div class="am-sound-row">${html}</div></label>`;
  let html = `
    ${row(`ширина, px <span class="hint" id="plp-w-val">${o.w}</span>`, `<input type="range" id="plp-w" min="20" max="2000" value="${o.w}" />`)}
    ${row('прозрачность', `<input type="range" id="plp-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="plp-op-val">${o.opacity}%</span>`)}
    <div class="rp-row">
      <label class="hint">слой: сверху 🡒</label>
      <button class="act ghost" id="plp-zup" title="поднять слой">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="plp-zdown" title="опустить слой">▼</button>
      <label class="hint"><input type="checkbox" id="plp-idle" ${o.hideOnIdle ? 'checked' : ''} /> прятать, когда ничего не играет</label>
    </div>`;
  if (o.type === 'marquee') {
    html += row('строка', `<span class="hint">цвет</span><input type="color" id="plp-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="plp-fs" min="10" max="60" value="${o.fontSize}" style="width:56px" /><span class="hint">круг, сек</span><input type="number" id="plp-speed" min="5" max="300" value="${o.speed}" style="width:56px" />`);
  }
  if (o.type === 'backdrop' || o.type === 'image') {
    html += row('вид', `<span class="hint">углы</span><input type="number" id="plp-radius" min="0" max="120" value="${o.radius}" style="width:56px" />${o.type === 'backdrop' ? `<span class="hint">цвет</span><input type="color" id="plp-bcolor" value="${esc(o.color || '#0c0a19')}" />` : ''}`);
    html += `<label>картинка <select id="plp-img"></select></label>
      <div class="am-sound-row"><input type="file" id="plp-img-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="plp-img-up" title="загрузить и поставить сюда">⬆</button></div>`;
  }
  if (o.type === 'image') {
    html += `<div class="row"><button class="act ghost" id="plp-del" title="удалить этот элемент">🗑 Удалить элемент</button></div>`;
  }
  props.innerHTML = html;

  // слушатели полей
  $('#plp-w')?.addEventListener('pointerdown', plpPush);
  $('#plp-w')?.addEventListener('input', () => {
    plpPushThrottled();
    o.w = Number($('#plp-w').value);
    if (o.type === 'video') o.h = Math.round(o.w * 9 / 16);
    $('#plp-w-val').textContent = String(o.w);
    plpRenderStage();
  });
  $('#plp-op')?.addEventListener('input', () => {
    o.opacity = Number($('#plp-op').value);
    $('#plp-op-val').textContent = `${o.opacity}%`;
    plpRenderStage();
  });
  $('#plp-zup')?.addEventListener('click', () => { o.z = Math.min(30, o.z + 1); plpRenderStage(); plpRenderProps(); });
  $('#plp-zdown')?.addEventListener('click', () => { o.z = Math.max(0, o.z - 1); plpRenderStage(); plpRenderProps(); });
  $('#plp-idle')?.addEventListener('change', () => { o.hideOnIdle = $('#plp-idle').checked; });
  $('#plp-color')?.addEventListener('input', () => { o.color = $('#plp-color').value; plpRenderStage(); });
  $('#plp-fs')?.addEventListener('input', () => { o.fontSize = Number($('#plp-fs').value) || 22; o.h = o.fontSize + 16; plpRenderStage(); });
  $('#plp-speed')?.addEventListener('input', () => { o.speed = Number($('#plp-speed').value) || 30; plpRenderStage(); });
  $('#plp-radius')?.addEventListener('input', () => { o.radius = Number($('#plp-radius').value) || 0; plpRenderStage(); });
  $('#plp-bcolor')?.addEventListener('input', () => { o.color = $('#plp-bcolor').value; plpRenderStage(); });

  const imgSel = $('#plp-img');
  if (imgSel) {
    api('/api/media').then(({ files }) => {
      const images = files.filter((f) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'apng'].includes(fileExt(f)));
      imgSel.innerHTML = ['<option value="">— не задано —</option>',
        ...images.map((f) => `<option value="${esc(f)}" ${o.image === f ? 'selected' : ''}>${esc(f)}</option>`)].join('');
    }).catch(() => {});
    imgSel.addEventListener('change', () => { o.image = imgSel.value; plpRenderStage(); plpRenderProps(); });
    $('#plp-img-up')?.addEventListener('click', async () => {
      const file = $('#plp-img-file')?.files?.[0];
      if (!file) { toast('Сначала выбери картинку', true); return; }
      try {
        const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        o.image = file.name;
        toast('Картинка загружена и поставлена на элемент ✅');
        plpRenderStage();
        plpRenderProps();
      } catch (e) { toast(e.message, true); }
    });
  }
  $('#plp-del')?.addEventListener('click', () => {
    plpPush();
    plp.objects.splice(plp.sel, 1);
    plp.sel = Math.max(0, plp.sel - 1);
    plp.selSet = new Set(plp.sel >= 0 ? [plp.sel] : []);
    plpRenderStage();
    plpRenderProps();
  });
}

// ---------- копирование: ctrl+c / ctrl+x / ctrl+v ----------
function plpCopy(cut = false) {
  if (!plp.selSet.size) { toast('Сначала выдели объект(ы)', true); return; }
  plp.clipboard = [...plp.selSet].map((i) => JSON.parse(JSON.stringify(plp.objects[i])));
  if (cut) {
    plpPush();
    plp.objects = plp.objects.filter((_, i) => !plp.selSet.has(i));
    plp.selSet = new Set();
    plp.sel = -1;
    plpRenderStage();
    plpRenderProps();
    toast(`Вырезано: ${plp.clipboard.length}`);
  } else toast(`Скопировано: ${plp.clipboard.length}`);
}

function plpPaste() {
  if (!plp.clipboard?.length) { toast('Буфер пуст — сначала копируй (ctrl+c)', true); return; }
  plpPush();
  const pasted = [];
  for (const [n, o] of plp.clipboard.entries()) {
    const c = { ...o, x: o.x + 30, y: o.y + 30 };
    c.id = `${c.type}-${Date.now()}-${n}`;
    plp.objects.push(c);
    pasted.push(plp.objects.length - 1);
  }
  plp.selSet = new Set(pasted);
  plp.sel = pasted.at(-1);
  plpRenderStage();
  plpRenderProps();
  toast(`Вставлено: ${pasted.length}`);
}

// горячие клавиши редактора — только на вкладке Музыка и не в полях ввода
document.addEventListener('keydown', (e) => {
  if (!$('#tab-songs')?.classList.contains('active')) return;
  if (e.target.closest('input, textarea, select')) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); plpUndo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); plpRedo(); }
  else if (key === 'c') { e.preventDefault(); plpCopy(); }
  else if (key === 'x') { e.preventDefault(); plpCopy(true); }
  else if (key === 'v') { e.preventDefault(); plpPaste(); }
});

$('#plp-objects').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-i]');
  if (!chip) return;
  const i = Number(chip.dataset.i);
  if (e.shiftKey) {
    if (plp.selSet.has(i)) plp.selSet.delete(i);
    else plp.selSet.add(i);
    plp.sel = plp.selSet.has(i) ? i : plp.sel;
  } else {
    plp.selSet = new Set([i]);
    plp.sel = i;
  }
  plpRenderStage();
  plpRenderProps();
});

// ---------- тулбар редактора ----------
$('#plp-skip').addEventListener('click', async () => {
  try { await api('/api/actions/srnext', { method: 'POST', body: '{}' }); toast('Трек скипнут ⏭'); }
  catch (e) { toast(e.message, true); }
});
$('#plp-toggle').addEventListener('click', () => {
  const op = __songsPaused || window.__songsState?.paused ? 'resume' : 'pause';
  api('/api/actions/srcontrol', { method: 'POST', body: JSON.stringify({ op }) })
    .then(() => { __songsPaused = op === 'pause'; const b = $('#plp-toggle'); b.textContent = __songsPaused ? '▶' : '⏸'; })
    .catch((e) => toast(e.message, true));
});

$('#plp-add-image').addEventListener('click', () => $('#plp-image-file').click());
$('#plp-image-file').addEventListener('change', async () => {
  const file = $('#plp-image-file')?.files?.[0];
  if (!file) return;
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const zMax = Math.max(0, ...plp.objects.map((o) => o.z));
    plpPush();
    plp.objects.push({ id: `image-${Date.now()}`, type: 'image', x: 660, y: 340, w: 600, h: 400, opacity: 100, z: zMax + 1, hideOnIdle: false, image: file.name, radius: 0 });
    plp.sel = plp.objects.length - 1;
    $('#plp-image-file').value = '';
    plpRenderStage();
    plpRenderProps();
    toast('Элемент добавлен — двигай его в превью 🖼');
  } catch (e) { toast(e.message, true); }
});

// ⬇ SVG-шаблон: зоны всех объектов с честными размерами
$('#plp-template').addEventListener('click', () => {
  const colors = { video: '#22c55e', marquee: '#eab308', backdrop: '#8b5cf6', image: '#38bdf8' };
  const shapes = plp.objects.map((o) => `
  <rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="none" stroke="${colors[o.type]}" stroke-width="4" stroke-dasharray="14 8" rx="${o.radius}"/>
  <text x="${o.x + 8}" y="${Math.max(20, o.y - 8)}" fill="${colors[o.type]}" font-size="22" font-family="sans-serif">${PLP_TYPE_RU[o.type]} ${o.w}×${o.h} px, слой ${o.z}</text>`).join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <title>Шаблон оверлея плеера музыки</title>
  ${shapes}
</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'player-template.svg';
  a.click();
  URL.revokeObjectURL(url);
  toast('Шаблон скачан: зоны всех объектов с их размерами');
});

$('#plp-save').addEventListener('click', async () => {
  try {
    await putSettings({ songs: { playerCfg: { v: 2, objects: plp.objects } } });
    toast('Раскладка сохранена — открытый плеер в OBS обновится сразу ✅');
  } catch (e) { toast(e.message, true); }
});

function plpLoad(cfg, songsState) {
  plp = plpNorm(cfg);
  plp.sel = 0;
  plp.selSet = new Set(plp.objects.length ? [0] : []);
  window.__songsState = songsState ?? null;
  plpRenderStage();
  plpRenderProps();
}

// ---------------- 📺 редактор оверлей-виджета шатаута (аватар + текст) ----------------
// тот же UX, что у музыкального: drag, магнит, рамка, shift, ctrl+z/y/c/x/v

let aso = { objects: [], sel: 0, selSet: new Set(), duration: 8 };
const ASO_TYPE_RU = { avatar: '👤 аватар', banner: '🏞 баннер', text: '📝 текст', backdrop: '🟪 подложка', image: '🖼 картинка' };
const asoHist = [];
const asoRedoStack = [];
let asoLastPush = 0;
let asoClipboard = [];

function asoDefault() {
  // базовый шаблон (отредактирован стримером): подложка + круглая аватарка + текст ниже
  return [
    { id: 'backdrop-0', type: 'backdrop', x: 680, y: 280, w: 560, h: 260, opacity: 100, z: 1, color: '#0c0a19', radius: 20, image: '' },
    { id: 'avatar-0', type: 'avatar', x: 880, y: 330, w: 160, h: 160, opacity: 100, z: 3, radius: 80 },
    { id: 'text-0', type: 'text', x: 705, y: 540, w: 510, h: 194, opacity: 100, z: 4, color: '#ffffff', fontSize: 26, radius: 0 },
  ];
}

function asoNorm(raw) {
  const c = raw ?? {};
  const objects = (Array.isArray(c.objects) && c.objects.length
    ? c.objects.filter((o) => o && ['avatar', 'banner', 'text', 'backdrop', 'image'].includes(o.type))
    : asoDefault())
    .map((o, i) => ({
      id: o.id || `${o.type}-${i}`,
      type: o.type,
      x: Number(o.x) || 0, y: Number(o.y) || 0,
      w: Math.max(20, Number(o.w) || 300), h: Math.max(20, Number(o.h) || 300),
      opacity: Math.max(0, Math.min(100, Number(o.opacity ?? 100))),
      z: Math.max(0, Math.min(30, Number(o.z ?? 1))),
      image: String(o.image || ''),
      color: String(o.color || ''),
      radius: Math.max(0, Number(o.radius) || 0),
      fontSize: Math.max(10, Number(o.fontSize) || 22),
    }));
  return {
    v: 1,
    objects,
    duration: Math.max(2, Math.min(60, Number(c.duration) || 8)),
  };
}

function asoK() { const s = $('#aso-stage'); return s ? s.clientWidth / 1920 : 0.25; }

function asoPush() {
  asoHist.push(JSON.stringify(aso.objects));
  if (asoHist.length > 60) asoHist.shift();
  asoRedoStack.length = 0;
  asoLastPush = Date.now();
}
function asoPushThrottled() { if (Date.now() - asoLastPush > 600) asoPush(); }

function asoUndo() {
  if (!asoHist.length) { toast('Отменять нечего'); return; }
  asoRedoStack.push(JSON.stringify(aso.objects));
  aso.objects = JSON.parse(asoHist.pop());
  aso.selSet = new Set();
  aso.sel = -1;
  asoRenderStage();
  asoRenderProps();
}
function asoRedo() {
  if (!asoRedoStack.length) { toast('Повторять нечего'); return; }
  asoHist.push(JSON.stringify(aso.objects));
  aso.objects = JSON.parse(asoRedoStack.pop());
  aso.selSet = new Set();
  aso.sel = -1;
  asoRenderStage();
  asoRenderProps();
}

function asoText() {
  return window.__settings?.autoShoutouts?.defaultTemplate || 'Стример {target} у нас в чате! Поддержим: twitch.tv/{target_login} ❤️';
}

function asoRenderStage() {
  const stage = $('#aso-stage');
  if (!stage) return;
  const k = asoK();
  const sorted = aso.objects.map((o, i) => ({ o, i })).sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
  stage.innerHTML = '';
  for (const { o, i } of sorted) {
    const div = document.createElement('div');
    div.className = `plp-obj plp-${o.type}${aso.selSet.has(i) ? ' sel' : ''}`;
    div.dataset.i = i;
    div.style.left = `calc(50% + ${Math.round((o.x - 960) * k)}px)`;
    div.style.top = `calc(50% + ${Math.round((o.y - 540) * k)}px)`;
    div.style.width = `${o.w * k}px`;
    div.style.height = `${o.h * k}px`;
    div.style.opacity = String(o.opacity / 100);
    div.style.borderRadius = `${o.radius * k}px`;
    if (o.type === 'avatar') {
      div.style.background = 'rgba(139, 92, 246, .25)';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent = 'center';
      div.style.fontSize = `${Math.min(o.w, o.h) * k * 0.5}px`;
      div.innerHTML = '🧑';
    } else if (o.type === 'banner') {
      div.style.background = 'rgba(139, 92, 246, .18)';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent = 'center';
      div.style.fontSize = `${Math.min(o.w, o.h) * k * 0.5}px`;
      div.innerHTML = '🏞';
    } else if (o.type === 'text') {
      div.style.color = o.color || '#ffffff';
      div.style.fontSize = `${o.fontSize * k}px`;
      div.style.fontWeight = '700';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.overflow = 'hidden';
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = asoText();
    } else if (o.type === 'backdrop') {
      if (o.image) div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
      else div.style.backgroundColor = o.color || '#0c0a19';
    } else if (o.type === 'image') {
      if (o.image) div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
    }
    if (aso.selSet.size === 1 && i === aso.sel) {
      const h = document.createElement('div');
      h.className = 'plp-resize';
      div.appendChild(h);
    }
    stage.appendChild(div);
  }
}

function asoSnap(nx, ny, self) {
  const others = aso.objects.filter((_, j) => !aso.selSet.has(j));
  const anchorsX = [nx, nx + self.w / 2, nx + self.w];
  const anchorsY = [ny, ny + self.h / 2, ny + self.h];
  const targetsX = [{ pos: 960, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.x, kind: 'obj' }, { pos: t.x + t.w / 2, kind: 'obj' }, { pos: t.x + t.w, kind: 'obj' }])];
  const targetsY = [{ pos: 540, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.y, kind: 'obj' }, { pos: t.y + t.h / 2, kind: 'obj' }, { pos: t.y + t.h, kind: 'obj' }])];
  let bestX = null;
  for (const a of anchorsX) for (const t of targetsX) {
    const d = t.pos - a;
    if (Math.abs(d) <= 14 && (!bestX || Math.abs(d) < Math.abs(bestX.shift))) bestX = { shift: d, target: t };
  }
  let bestY = null;
  for (const a of anchorsY) for (const t of targetsY) {
    const d = t.pos - a;
    if (Math.abs(d) <= 14 && (!bestY || Math.abs(d) < Math.abs(bestY.shift))) bestY = { shift: d, target: t };
  }
  return { x: nx + (bestX ? bestX.shift : 0), y: ny + (bestY ? bestY.shift : 0), guides: { v: bestX ? bestX.target : null, h: bestY ? bestY.target : null } };
}

function asoGuides({ v, h }) {
  $('#aso-guide-v')?.remove();
  $('#aso-guide-h')?.remove();
  if (!v && !h) return;
  const stage = $('#aso-stage');
  const k = asoK();
  if (v) {
    const g = document.createElement('div');
    g.id = 'aso-guide-v';
    g.className = `plp-guide plp-guide-v ${v.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.left = `${v.pos * k}px`;
    stage.appendChild(g);
  }
  if (h) {
    const g = document.createElement('div');
    g.id = 'aso-guide-h';
    g.className = `plp-guide plp-guide-h ${h.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.top = `${h.pos * k}px`;
    stage.appendChild(g);
  }
}

function asoRenderProps() {
  const chips = $('#aso-objects');
  const props = $('#aso-props');
  if (!chips || !props) return;
  chips.innerHTML = aso.objects.map((o, i) =>
    `<span class="chip${aso.selSet.has(i) ? ' sel' : ''}" data-i="${i}">${ASO_TYPE_RU[o.type] ?? o.type}${o.type === 'image' && o.image ? ` · ${esc(o.image)}` : ''}</span>`
  ).join('');
  if (!aso.selSet.size) {
    props.innerHTML = '<p class="hint">Клик — выделить · shift+клик — несколько · рамка по пустому месту. Хоткеи: ctrl+z/y/c/x/v. На стриме виджет всплывает при шатауте и исчезает сам.</p>';
    return;
  }
  if (aso.selSet.size > 1) {
    props.innerHTML = `
      <p class="hint">выделено: ${aso.selSet.size} — тащатся вместе</p>
      <div class="rp-row">
        <button class="act ghost" id="aso-zup">▲ слой</button>
        <button class="act ghost" id="aso-zdown">▼ слой</button>
        <button class="act ghost" id="aso-del">🗑 удалить выбранное</button>
      </div>`;
    $('#aso-zup').addEventListener('click', () => { for (const i of aso.selSet) aso.objects[i].z = Math.min(30, aso.objects[i].z + 1); asoRenderStage(); asoRenderProps(); });
    $('#aso-zdown').addEventListener('click', () => { for (const i of aso.selSet) aso.objects[i].z = Math.max(0, aso.objects[i].z - 1); asoRenderStage(); asoRenderProps(); });
    $('#aso-del').addEventListener('click', () => {
      asoPush();
      aso.objects = aso.objects.filter((_, i) => !aso.selSet.has(i));
      aso.selSet = new Set();
      aso.sel = -1;
      asoRenderStage();
      asoRenderProps();
    });
    return;
  }
  const o = aso.objects[aso.sel];
  if (!o) { props.innerHTML = ''; return; }
  const row = (label, html) => `<label>${label}<div class="am-sound-row">${html}</div></label>`;
  let html = `
    ${row(`ширина, px <span class="hint" id="aso-w-val">${o.w}</span>`, `<input type="range" id="aso-w" min="20" max="2000" value="${o.w}" />`)}
    ${row('прозрачность', `<input type="range" id="aso-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="aso-op-val">${o.opacity}%</span></div>`)}
    <div class="rp-row">
      <label class="hint">слой:</label>
      <button class="act ghost" id="aso-zup" title="поднять">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="aso-zdown" title="опустить">▼</button>`;
  if (o.type === 'text') {
    html += row('текст', `<span class="hint">цвет</span><input type="color" id="aso-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="aso-fs" min="10" max="60" value="${o.fontSize}" style="width:56px" />`);
  }
  html += row('закругление', `<input type="number" id="aso-radius" min="0" max="120" value="${o.radius}" style="width:56px" />`);
  if (o.type === 'backdrop' || o.type === 'image') {
    html += o.type === 'backdrop' ? row('цвет', `<input type="color" id="aso-bcolor" value="${esc(o.color || '#0c0a19')}" />`) : '';
    html += `<label>картинка <select id="aso-img"></select></label>
      <div class="am-sound-row"><input type="file" id="aso-img-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="aso-img-up">⬆</button></div>`;
  }
  html += `<button class="act ghost" id="aso-del">🗑 Удалить объект</button></div>`;
  props.innerHTML = html;

  $('#aso-w').addEventListener('pointerdown', asoPushThrottled);
  $('#aso-w').addEventListener('input', () => {
    o.w = Number($('#aso-w').value);
    if (o.type === 'avatar') o.h = o.w; // аватар квадратный
    $('#aso-w-val').textContent = String(o.w);
    asoRenderStage();
  });
  $('#aso-op').addEventListener('input', () => {
    o.opacity = Number($('#aso-op').value);
    $('#aso-op-val').textContent = `${o.opacity}%`;
    asoRenderStage();
  });
  $('#aso-zup').addEventListener('click', () => { o.z = Math.min(30, o.z + 1); asoRenderStage(); asoRenderProps(); });
  $('#aso-zdown').addEventListener('click', () => { o.z = Math.max(0, o.z - 1); asoRenderStage(); asoRenderProps(); });
  $('#aso-color')?.addEventListener('input', () => { o.color = $('#aso-color').value; asoRenderStage(); });
  $('#aso-fs')?.addEventListener('pointerdown', asoPushThrottled);
  $('#aso-fs')?.addEventListener('input', () => { o.fontSize = Number($('#aso-fs').value) || 22; asoRenderStage(); });
  $('#aso-radius')?.addEventListener('pointerdown', asoPushThrottled);
  $('#aso-radius')?.addEventListener('input', () => { o.radius = Number($('#aso-radius').value) || 0; asoRenderStage(); });
  $('#aso-bcolor')?.addEventListener('input', () => { o.color = $('#aso-bcolor').value; asoRenderStage(); });
  $('#aso-del').addEventListener('click', () => {
    asoPush();
    aso.objects.splice(aso.sel, 1);
    aso.sel = Math.max(-1, aso.sel - 1);
    aso.selSet = aso.sel >= 0 ? new Set([aso.sel]) : new Set();
    asoRenderStage();
    asoRenderProps();
  });

  const imgSel = $('#aso-img');
  if (imgSel) {
    api('/api/media').then(({ files }) => {
      const images = files.filter((f) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'apng'].includes(fileExt(f)));
      imgSel.innerHTML = ['<option value="">— не задано —</option>',
        ...images.map((f) => `<option value="${esc(f)}" ${o.image === f ? 'selected' : ''}>${esc(f)}</option>`)].join('');
    }).catch(() => {});
    imgSel.addEventListener('change', () => { asoPush(); o.image = imgSel.value; asoRenderStage(); asoRenderProps(); });
    $('#aso-img-up').addEventListener('click', async () => {
      const file = $('#aso-img-file')?.files?.[0];
      if (!file) { toast('Сначала выбери картинку', true); return; }
      const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || `HTTP ${r.status}`, true); return; }
      asoPush();
      o.image = file.name;
      toast('Картинка загружена ✅');
      asoRenderStage();
      asoRenderProps();
    });
  }
}

// drag/рамка/магнит — как у редактора музыки, на своей сцене
(() => {
  const stage = $('#aso-stage');
  if (!stage) return;
  let mode = null;
  let idx = -1;
  let grabX = 0, grabY = 0;
  let starts = null;
  let band = null;
  let bandShift = false;
  let moved = false;
  let pendingGuides = null;

  const snapshot = () => {
    starts = new Map();
    for (const i of aso.selSet) starts.set(i, { ...aso.objects[i] });
  };

  stage.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.plp-resize');
    const obj = e.target.closest('.plp-obj');
    grabX = e.clientX; grabY = e.clientY;
    moved = false;
    stage.setPointerCapture?.(e.pointerId);
    if (!obj) {
      mode = 'band';
      bandShift = e.shiftKey;
      band = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
      asoGuides({ v: null, h: null });
      e.preventDefault();
      return;
    }
    idx = Number(obj.dataset.i);
    aso.sel = idx;
    if (e.shiftKey) {
      if (aso.selSet.has(idx)) aso.selSet.delete(idx);
      else aso.selSet.add(idx);
    } else if (!aso.selSet.has(idx)) {
      aso.selSet = new Set([idx]);
    }
    if (!aso.selSet.size) aso.selSet = new Set([idx]);
    aso.sel = aso.selSet.has(idx) ? idx : [...aso.selSet][0];
    mode = (handle && aso.selSet.size === 1) ? 'resize' : 'move';
    snapshot();
    asoPush();
    asoRenderStage();
    asoRenderProps();
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const k = asoK();
    moved = true;
    if (mode === 'band') {
      const r = stage.getBoundingClientRect();
      band = {
        x: Math.min(grabX, e.clientX) - r.left,
        y: Math.min(grabY, e.clientY) - r.top,
        w: Math.abs(e.clientX - grabX),
        h: Math.abs(e.clientY - grabY),
      };
      $('#aso-band')?.remove();
      const b = document.createElement('div');
      b.id = 'aso-band';
      b.style.left = `${band.x}px`;
      b.style.top = `${band.y}px`;
      b.style.width = `${band.w}px`;
      b.style.height = `${band.h}px`;
      stage.appendChild(b);
      return;
    }
    const dx = (e.clientX - grabX) / k;
    const dy = (e.clientY - grabY) / k;
    if (mode === 'move') {
      const anchor = starts.get(idx);
      if (!anchor) return;
      const snap = asoSnap(anchor.x + dx, anchor.y + dy, anchor);
      const shiftX = snap.x - (anchor.x + dx);
      const shiftY = snap.y - (anchor.y + dy);
      for (const [i, s] of starts) {
        const o = aso.objects[i];
        o.x = Math.round(Math.max(-500, Math.min(2500, s.x + dx + shiftX)));
        o.y = Math.round(Math.max(-500, Math.min(2500, s.y + dy + shiftY)));
      }
      pendingGuides = snap.guides;
    } else {
      const o = aso.objects[idx];
      const s = starts.get(idx);
      o.w = Math.round(Math.max(20, Math.min(2500, s.w + dx)));
      o.h = o.type === 'avatar' ? o.w : Math.round(Math.max(20, Math.min(2500, s.h + dy)));
    }
    asoRenderStage();
    asoRenderProps();
    if (pendingGuides) { asoGuides(pendingGuides); pendingGuides = null; }
  });

  const stop = () => {
    if (mode === 'band') {
      $('#aso-band')?.remove();
      if (!moved && !bandShift) {
        aso.selSet = new Set();
        aso.sel = -1;
      } else if (band && (band.w > 3 || band.h > 3)) {
        aso.selSet = new Set();
        const k = asoK();
        for (const [i, o] of aso.objects.entries()) {
          const r = { x: o.x * k, y: o.y * k, w: o.w * k, h: o.h * k };
          if (r.x < band.x + band.w && r.x + r.w > band.x && r.y < band.y + band.h && r.y + r.h > band.y) aso.selSet.add(i);
        }
        if (aso.selSet.size) aso.sel = [...aso.selSet].at(-1);
      }
      asoRenderStage();
      asoRenderProps();
    }
    mode = null;
    starts = null;
    band = null;
    asoGuides({ v: null, h: null });
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
})();

$('#aso-objects').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-i]');
  if (!chip) return;
  const i = Number(chip.dataset.i);
  if (e.shiftKey) {
    if (aso.selSet.has(i)) aso.selSet.delete(i);
    else aso.selSet.add(i);
  } else aso.selSet = new Set([i]);
  aso.sel = i;
  asoRenderStage();
  asoRenderProps();
});

$('#aso-props').addEventListener('pointerdown', asoPushThrottled);

function asoCopy(cut = false) {
  if (!aso.selSet.size) { toast('Сначала выдели объект(ы)', true); return; }
  asoClipboard = [...aso.selSet].map((i) => JSON.parse(JSON.stringify(aso.objects[i])));
  if (cut) {
    asoPush();
    aso.objects = aso.objects.filter((_, i) => !aso.selSet.has(i));
    aso.selSet = new Set();
    aso.sel = -1;
    asoRenderStage();
    asoRenderProps();
    toast(`Вырезано: ${asoClipboard.length}`);
  } else toast(`Скопировано: ${asoClipboard.length}`);
}
function asoPaste() {
  if (!asoClipboard?.length) { toast('Буфер пуст', true); return; }
  asoPush();
  const pasted = [];
  for (const [n, o] of asoClipboard.entries()) {
    const c = { ...o, x: o.x + 30, y: o.y + 30 };
    c.id = `${c.type}-${Date.now()}-${n}`;
    aso.objects.push(c);
    pasted.push(aso.objects.length - 1);
  }
  aso.selSet = new Set(pasted);
  aso.sel = pasted.at(-1);
  asoRenderStage();
  asoRenderProps();
}

document.addEventListener('keydown', (e) => {
  if (!$('#tab-autoso')?.classList.contains('active')) return;
  if (e.target.closest('input, textarea, select')) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); asoUndo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); asoRedo(); }
  else if (key === 'c') { e.preventDefault(); asoCopy(); }
  else if (key === 'x') { e.preventDefault(); asoCopy(true); }
  else if (key === 'v') { e.preventDefault(); asoPaste(); }
});

$('#aso-widget-test').addEventListener('click', async () => {
  try {
    await api('/api/actions/soshouttest', { method: 'POST', body: '{}' });
    toast('Тестовый шатаут отправлен — смотри оверлей (страница должна быть открыта)');
  } catch (e) { toast(e.message, true); }
});
$('#aso-widget-addbanner').addEventListener('click', () => {
  asoPush();
  const zMax = Math.max(0, ...aso.objects.map((o) => o.z));
  aso.objects.push({ id: `banner-${Date.now()}`, type: 'banner', x: 680, y: 180, w: 560, h: 90, opacity: 100, z: zMax + 1, radius: 16 });
  aso.sel = aso.objects.length - 1;
  aso.selSet = new Set([aso.sel]);
  asoRenderStage();
  asoRenderProps();
  toast('Баннер добавлен: на стриме в него ляжет баннер канала человека 🏞');
});
$('#aso-widget-add').addEventListener('click', () => $('#aso-image-file').click());
$('#aso-image-file').addEventListener('change', async () => {
  const file = $('#aso-image-file')?.files?.[0];
  if (!file) return;
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const zMax = Math.max(0, ...aso.objects.map((o) => o.z));
    asoPush();
    aso.objects.push({ id: `image-${Date.now()}`, type: 'image', x: 700, y: 350, w: 500, h: 320, opacity: 100, z: zMax + 1, image: file.name, radius: 0 });
    aso.sel = aso.objects.length - 1;
    aso.selSet = new Set([aso.sel]);
    $('#aso-image-file').value = '';
    asoRenderStage();
    asoRenderProps();
    toast('Элемент добавлен 🖼');
  } catch (e) { toast(e.message, true); }
});
$('#aso-widget-save').addEventListener('click', async () => {
  try {
    await putSettings({ shoutoutOverlay: { v: 1, duration: Number($('#aso-duration').value) || 10, objects: aso.objects } });
    toast('Раскладка виджета шатаута сохранена ✅');
  } catch (e) { toast(e.message, true); }
});
$('#aso-widget-reset').addEventListener('click', () => {
  asoPush();
  aso.objects = asoDefault();
  aso.sel = 0;
  aso.selSet = new Set([0]);
  asoRenderStage();
  asoRenderProps();
  toast('Дефолтная раскладка (не забудь сохранить)');
});

function asoLoad(cfg) {
  const n = asoNorm(cfg);
  aso.objects = n.objects;
  aso.duration = n.duration;
  aso.sel = 0;
  aso.selSet = new Set(aso.objects.length ? [0] : []);
  $('#aso-duration').value = aso.duration;
  asoRenderStage();
  asoRenderProps();
}

$('#sg-body').addEventListener('click', async (e) => {
  // клик по названию — скопировать ссылку на трек
  const link = e.target.closest('.sg-title-link');
  if (link) {
    try { await navigator.clipboard.writeText(`https://youtu.be/${link.dataset.id}`); toast('Ссылка на трек скопирована 🔗'); } catch {}
    return;
  }
  // 🚫 — в чёрный список одним нажатием (сервер сам выкинет трек из очереди)
  const bl = e.target.closest('.sg-bl');
  if (bl) {
    if (!confirm(`Заблокировать трек «${bl.dataset.title || bl.dataset.id}»? Он исчезнет из очереди, и его больше нельзя заказать.`)) return;
    try {
      const r = await api('/api/songs', { method: 'POST', body: JSON.stringify({ op: 'blacklist-add', url: bl.dataset.id }) });
      if (r.error) { toast(r.error, true); return; }
      toast('Трек заблокирован 🚫');
      loadSongsTab();
    } catch (err) { toast(err.message, true); }
    return;
  }
  const row = e.target.closest('tr[data-index]');
  if (!row || !e.target.classList.contains('sg-remove')) return;
  try {
    await api('/api/songs', { method: 'POST', body: JSON.stringify({ op: 'remove', index: Number(row.dataset.index) }) });
    toast('Убрано из очереди');
    loadSongsTab();
  } catch (err) { toast(err.message, true); }
});

// ---------------- прокси (под-вкладка в Настройках) ----------------

async function loadProxySettings() {
  const p = (await api('/api/settings')).proxy ?? {};
  $('#proxy-enabled').checked = Boolean(p.enabled);
  $('#proxy-url').value = p.url ?? '';
}

$('#proxy-save').addEventListener('click', async () => {
  try {
    await putSettings({
      proxy: { enabled: $('#proxy-enabled').checked, url: $('#proxy-url').value.trim() },
    });
    toast('Прокси сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

$('#proxy-test').addEventListener('click', async () => {
  toast('Проверяю связь…');
  try {
    const r = await api('/api/actions/proxytest', { method: 'POST', body: '{}' });
    toast(`✅ ${r.via} — YouTube доступен («${r.sample}»)`);
  } catch (e) { toast(`❌ ${e.message}`, true); }
});

// ---------------- модули ----------------

async function loadModules() {
  const { modules } = await api('/api/modules');
  $('#modules-count').textContent = modules.length ? `модулей: ${modules.length}` : 'модулей нет';
  const box = $('#modules-list');
  box.innerHTML = modules.map((m) => {
    const settingsRows = Object.entries(m.settings ?? {}).map(([k, v]) => {
      if (typeof v === 'boolean') {
        return `<label class="hint"><input class="m-set" data-key="${esc(k)}" type="checkbox" ${v ? 'checked' : ''} /> ${esc(k)}</label>`;
      }
      return `<label class="hint">${esc(k)} <input class="m-set" data-key="${esc(k)}" type="${typeof v === 'number' ? 'number' : 'text'}" value="${esc(String(v))}" style="width:170px" /></label>`;
    }).join('') || '<p class="hint">настроек нет — модуль может объявить их в поле settings</p>';
    return `
    <details class="rp-item" data-name="${esc(m.name)}">
      <summary>
        <code>${esc(m.name)}</code>
        ${m.error ? '<span class="chip">💥 не загрузился</span>' : `<span class="chip">${m.enabled ? '✅ вкл' : '⏸ выкл'}</span>`}
        <span class="hint">${esc(m.description || '')}</span>
      </summary>
      <div class="rp-config">
        ${m.error ? `<p class="hint">💥 ${esc(m.error)}</p>` : `
        <div class="rp-row">
          <label class="hint"><input class="m-enabled" type="checkbox" ${m.enabled ? 'checked' : ''} /> включен</label>
        </div>
        <label class="hint">команды: ${m.commands.map((c) => `<code>!${esc(c)}</code>`).join(' ') || '—'}</label>
        <label class="hint">события: ${m.hooks.map((h) => `<code>${esc(h)}</code>`).join(' ') || '—'}</label>
        <label class="hint">настройки (хранятся в data/modules.json)</label>
        <div class="rp-row">${settingsRows}</div>
        <div class="rp-row">
          <button class="act m-save">💾 Сохранить настройки</button>
        </div>`}
      </div>
    </details>`;
  }).join('') || '<p class="hint">Модулей нет. Кинь .js-файл в папку modules/ (формат — в README) или правь example.js.</p>';
}

$('#modules-reload').addEventListener('click', async () => {
  try {
    await api('/api/actions/modulesreload', { method: 'POST', body: '{}' });
    toast('Модули перечитаны ✅');
    loadModules();
  } catch (e) { toast(e.message, true); }
});

$('#modules-list').addEventListener('change', async (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item || !e.target.classList.contains('m-enabled')) return;
  try {
    await api('/api/modules', { method: 'PUT', body: JSON.stringify({ name: item.dataset.name, enabled: e.target.checked }) });
    toast(`Модуль ${e.target.checked ? 'включён' : 'выключен'}`);
    loadModules();
  } catch (err) { toast(err.message, true); }
});

$('#modules-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item || !e.target.classList.contains('m-save')) return;
  const settings = {};
  item.querySelectorAll('.m-set').forEach((inp) => {
    settings[inp.dataset.key] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? Number(inp.value) : inp.value);
  });
  try {
    await api('/api/modules', { method: 'PUT', body: JSON.stringify({ name: item.dataset.name, settings }) });
    toast('Настройки модуля сохранены ✅');
    loadModules();
  } catch (err) { toast(err.message, true); }
});

// ---------------- настройки ----------------

$('#cfg-save').addEventListener('click', async () => {
  const body = {
    clientId: $('#cfg-client-id').value.trim(),
    port: Number($('#cfg-port').value) || undefined,
  };
  const secret = $('#cfg-client-secret').value.trim();
  if (secret) body.clientSecret = secret;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    settingsFormTouched = false; // поля снова можно синхронизировать с сервером
    $('#cfg-client-secret').value = '';
    toast('Настройки сохранены ✅ Теперь войди как бот, если ещё не');
    poll();
  } catch (e) { toast(e.message, true); }
});

$('#auth-logout').addEventListener('click', async () => {
  if (!confirm('Сбросить токен бота? Нужно будет войти заново.')) return;
  try {
    await api('/api/logout', { method: 'POST' });
    toast('Токен сброшен');
    poll();
  } catch (e) { toast(e.message, true); }
});

// ---------------- быстрые действия ----------------

document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  const testBtn = e.target.closest('[data-test]');
  if (!actBtn && !testBtn) return;

  if (testBtn) {
    try {
      await api('/api/actions/test', { method: 'POST', body: JSON.stringify({ kind: testBtn.dataset.test, channel: qaChannel() }) });
      toast('Тестовое событие отправлено — смотри чат');
    } catch (err) { toast(err.message, true); }
    return;
  }

  const act = actBtn.dataset.act;
  try {
    if (act === 'say') {
      const text = $('#qa-say').value.trim();
      if (!text) return;
      await api('/api/actions/say', { method: 'POST', body: JSON.stringify({ text, channel: qaChannel() }) });
      $('#qa-say').value = '';
      toast('Отправлено ✅');
    } else if (act === 'announce') {
      const text = $('#qa-announce').value.trim();
      if (!text) return;
      await api('/api/actions/announce', { method: 'POST', body: JSON.stringify({ text, color: $('#qa-announce-color').value, channel: qaChannel() }) });
      $('#qa-announce').value = '';
      toast('Анонс отправлен ✅');
    } else if (act === 'pin') {
      const text = $('#qa-pin').value.trim();
      if (!text) return;
      await api('/api/actions/pin', { method: 'POST', body: JSON.stringify({ text, duration: Number($('#qa-pin-duration').value), channel: qaChannel() }) });
      $('#qa-pin').value = '';
      toast('Закреплено 📌');
    } else if (act === 'unpin') {
      await api('/api/actions/unpin', { method: 'POST', body: JSON.stringify({ channel: qaChannel() }) });
      toast('Закреп снят');
    } else if (act === 'so') {
      const target = $('#qa-so').value.trim();
      if (!target) return;
      await api('/api/actions/so', { method: 'POST', body: JSON.stringify({ target, channel: qaChannel() }) });
      $('#qa-so').value = '';
      toast('Шатаут отправлен 📣');
    }
  } catch (err) { toast(err.message, true); }
});

$('#redirect-uri').addEventListener('click', (e) => {
  navigator.clipboard?.writeText(e.target.textContent).then(() => toast('Redirect URL скопирован'));
});

// ---------------- запуск ----------------

handleHash();
loadCommands().catch(() => {});
loadSettings().catch(() => {});
loadModules().catch(() => {});
loadOverlaySettings().catch(() => {});
loadSongsTab().catch(() => {});
loadProxySettings().catch(() => {});
loadQuotes().catch(() => {});
poll();
setInterval(poll, 2000);
