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

// ---------- шрифты для редакторов раскладки (виджет-объекты) ----------
const FONT_CHOICES = [
  ['', 'По умолчанию (наследует оверлей)'],
  ['Consolas, monospace', 'Consolas / моноширинный'],
  ["'Courier New', monospace", 'Courier New'],
  ['Arial, sans-serif', 'Arial / без засечек'],
  ["'Segoe UI', sans-serif", 'Segoe UI'],
  ["'Times New Roman', serif", 'Times New Roman / с засечками'],
  ['Georgia, serif', 'Georgia'],
  ["'Comic Sans MS', cursive", 'Рукописный (Comic Sans)'],
  ["'Segoe Print', cursive", 'Segoe Print'],
];
const fontOptions = (val) => FONT_CHOICES
  .map(([v, l]) => `<option value="${esc(v)}"${(v || '') === (val || '') ? ' selected' : ''}>${l}</option>`)
  .join('');

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
    try { localStorage.setItem('panel:tab', btn.dataset.tab); } catch {}
    // вкладка была скрыта — превью раскладки музыки рисовалось с нулевой шириной; перерисуем
    if (btn.dataset.tab === 'songs') requestAnimationFrame(() => { plpRenderStage(); plpRenderProps(); });
    if (btn.dataset.tab === 'autoso') requestAnimationFrame(() => { asoRenderStage(); asoRenderProps(); });
    if (btn.dataset.tab === 'overlay') requestAnimationFrame(() => { wodRenderStage(); wodRenderProps(); whEdLoad(whOverlay); });
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
    try { localStorage.setItem(`panel:subtab:${pane.id.replace('tab-', '')}`, btn.dataset.subtab); } catch {}
  });
});

// после F5 — вернуться на вкладку/подвкладку, где пользователь был (клик = тот же путь, что руками)
(() => {
  let savedTab = null;
  try { savedTab = localStorage.getItem('panel:tab'); } catch {}
  if (savedTab && $(`.tab[data-tab="${savedTab}"]`)) {
    $(`.tab[data-tab="${savedTab}"]`).click();
    let savedSub = null;
    try { savedSub = localStorage.getItem(`panel:subtab:${savedTab}`); } catch {}
    if (savedSub && $(`#tab-${savedTab} .subtab[data-subtab="${savedSub}"]`)) {
      $(`#tab-${savedTab} .subtab[data-subtab="${savedSub}"]`).click();
    }
  }
})();
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
  try { dtRender(st); } catch {}
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
  // «Войти» показываем только пока входа нет: после входа прячем — иначе
  // Twitch каждый раз просит «Authorize» и выглядит как «опять авторизуйся»
  $('#auth-login').classList.toggle('hidden', !configured || Boolean(a.login));
  $('#auth-logout').classList.toggle('hidden', !a.login);
  $('#auth-info').innerHTML = a.login
    ? `Вход выполнен: <b>${esc(a.login)}</b>${a.expiresAt ? ` · токен истекает ${new Date(a.expiresAt).toLocaleString('ru-RU')}` : ''}`
    : '';

  // строка «баллы бота: N» (внутренняя points-система; строки нет у логина — сервер отдаёт 0)
  const botPointsEl = $('#bot-points');
  if (botPointsEl) botPointsEl.innerHTML = `баллы бота: <b>${Number(st.botPoints ?? 0)}</b>`;

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
  // сервер мог молча не принять часть значений (занятое имя и т.п.) — говорим об этом,
  // иначе юзер видит «сохранено ✅», а после F5 — «сброс»
  if (Array.isArray(st?.warnings)) {
    for (const w of st.warnings) toast(w, true);
    delete st.warnings;
  }
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
// виджет маленький: сцена = сам виджет 440×180 (координаты локальные), на стриме встаёт в угол

const WOD_W = 440;
const WOD_H = 180;

let wodEd = { objects: [], enabled: false, corner: 'top-right' };
const WOD_TYPE_RU = { caption: '🏷 надпись', word: '🔤 слово', count: '🔢 счётчик', backdrop: '🟪 подложка', image: '🖼 картинка' };
const wodHist = [];
const wodRedoStack = [];
let wodLastPush = 0;
let wodClipboard = [];

function wodDefault() {
  // компактная карточка: подложка на весь виджет + надпись/слово/счётчик внутри
  return [
    { id: 'backdrop-0', type: 'backdrop', x: 0, y: 0, w: WOD_W, h: WOD_H, opacity: 80, z: 1, color: '#0c0a19', radius: 18, rotate: 0, image: '', borderColor: '', borderWidth: 0 },
    { id: 'caption-0', type: 'caption', x: 20, y: 16, w: 300, h: 24, opacity: 85, z: 3, color: '#ffffff', text: 'Слово дня:', fontSize: 15, radius: 0, rotate: 0, borderColor: '', borderWidth: 0 },
    { id: 'word-0', type: 'word', x: 20, y: 46, w: 300, h: 52, opacity: 100, z: 4, color: '#ffffff', fontSize: 28, radius: 0, rotate: 0, borderColor: '', borderWidth: 0 },
    { id: 'count-0', type: 'count', x: 340, y: 54, w: 80, h: 44, opacity: 95, z: 4, color: '#ffffff', fontSize: 18, radius: 12, rotate: 0, borderColor: '', borderWidth: 0 },
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
      fontFamily: String(o.fontFamily || '').slice(0, 80),
      visible: o.visible !== false,
      borderColor: String(o.borderColor || ''),
      borderWidth: Math.max(0, Math.min(12, Number(o.borderWidth) || 0)),
    }));
  return {
    enabled: Boolean(c.enabled),
    corner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(c.corner) ? c.corner : 'top-right',
    objects,
  };
}

function wodK() { return 1; } // виджет маленький: превью = реальный размер, без масштаба
const WOD_OX = 110; // зона виджета в сцене редактора
const WOD_OY = 45;

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
  // сцена 660×270, зона виджета 440×180 в центре (110, 45) — координаты объектов локальные виджету
  const OX = 110;
  const OY = 45;
  const k = 1; // виджет в реальном размере
  const sorted = wodEd.objects.map((o, i) => ({ o, i })).sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
  stage.innerHTML = '<div id="wod-zone"></div>';
  for (const { o, i } of sorted) {
    const div = document.createElement('div');
    div.className = `plp-obj plp-${o.type}${wodSel.has(i) ? ' sel' : ''}`;
    div.dataset.i = i;
    div.style.left = `${Math.round(OX + o.x * k)}px`;
    div.style.top = `${Math.round(OY + o.y * k)}px`;
    div.style.width = `${o.w * k}px`;
    div.style.height = `${o.h * k}px`;
    div.style.opacity = String(o.visible === false ? (o.opacity / 100) * 0.25 : o.opacity / 100);
    div.style.borderRadius = `${o.radius * k}px`;
    div.style.transform = o.rotate ? `rotate(${o.rotate}deg)` : '';
    div.style.outline = o.visible === false ? '2px dashed #f59e0b' : '';
    div.title = o.visible === false ? 'скрыт (не виден на стриме)' : '';
    if (o.borderWidth) div.style.border = `${o.borderWidth}px solid ${o.borderColor || '#8b5cf6'}`;
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
      if (o.fontFamily) div.style.fontFamily = o.fontFamily;
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
  const targetsX = [{ pos: WOD_W / 2, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.x, kind: 'obj' }, { pos: t.x + t.w / 2, kind: 'obj' }, { pos: t.x + t.w, kind: 'obj' }])];
  const targetsY = [{ pos: WOD_H / 2, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.y, kind: 'obj' }, { pos: t.y + t.h / 2, kind: 'obj' }, { pos: t.y + t.h, kind: 'obj' }])];
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
    g.style.left = `${WOD_OX + v.pos * k}px`;
    stage.appendChild(g);
  }
  if (h) {
    const g = document.createElement('div');
    g.id = 'wod-guide-h';
    g.className = `plp-guide plp-guide-h ${h.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.top = `${WOD_OY + h.pos * k}px`;
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
    <label class="hint"><input type="checkbox" id="woded-visible" ${o.visible === false ? '' : 'checked'} /> видимый на стриме</label>
    ${row('прозрачность', `<input type="range" id="woded-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="weded-op-val-x">${o.opacity}%</span>`)}
    ${row('поворот', `<input type="range" id="woded-rot" min="-15" max="15" value="${o.rotate}" /><span class="hint" id="woded-rot-val">${o.rotate}°</span>`)}
    <div class="rp-row">
      <label class="hint">слой:</label>
      <button class="act ghost" id="woded-zup" title="поднять">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="woded-zdown" title="опустить">▼</button>`;
  if (o.type === 'caption' || o.type === 'word' || o.type === 'count') {
    html += row('текст', `<span class="hint">цвет</span><input type="color" id="woded-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="woded-fs" min="10" max="60" value="${o.fontSize}" style="width:56px" />`);
    html += row('семейство шрифта', `<select id="woded-font" style="max-width:260px">${fontOptions(o.fontFamily)}</select>`);
  }
  if (o.type === 'caption') {
    html += `<label>надпись <input type="text" id="woded-text" class="wide" maxlength="60" value="${esc(o.text || 'Слово дня:')}" /></label>`;
  }
  html += row('закругление', `<input type="number" id="woded-radius" min="0" max="120" value="${o.radius}" style="width:56px" />`);
  html += row('грань (обводка)', `<span class="hint">цвет</span><input type="color" id="woded-bcolor2" value="${esc(o.borderColor || '#8b5cf6')}" /><span class="hint">толщ</span><input type="range" id="woded-bw" min="0" max="12" value="${o.borderWidth}" style="width:90px" /><span class="hint" id="woded-bw-val">${o.borderWidth}px</span>`);
  if (o.type === 'backdrop' || o.type === 'image') {
    html += o.type === 'backdrop' ? `<label>цвет <input type="color" id="woded-bcolor" value="${esc(o.color || '#0c0a19')}" style="width:46px" /></label>` : '';
    html += `<label>картинка <select id="woded-img"></select></label>
      <div class="am-sound-row"><input type="file" id="woded-img-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="woded-img-up">⬆</button></div>`;
  }
  html += `<button class="act ghost" id="woded-del">🗑 Удалить объект</button></div>`;
  props.innerHTML = html;

  $('#woded-visible')?.addEventListener('change', () => { wodPushThrottled(); o.visible = $('#woded-visible').checked; wodRenderStage(); });
  $('#woded-font')?.addEventListener('change', () => { o.fontFamily = $('#woded-font').value; wodRenderStage(); });
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
  $('#woded-bcolor2')?.addEventListener('input', () => { o.borderColor = $('#woded-bcolor2').value; wodRenderStage(); });
  $('#woded-bw')?.addEventListener('input', () => {
    o.borderWidth = Number($('#woded-bw').value) || 0;
    $('#woded-bw-val').textContent = `${o.borderWidth}px`;
    wodRenderStage();
  });
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
        o.x = Math.round(Math.max(-110, Math.min(WOD_W + 110, s.x + dx + shiftX)));
        o.y = Math.round(Math.max(-45, Math.min(WOD_H + 45, s.y + dy + shiftY)));
      }
      pendingGuides = snap.guides;
    } else {
      const o = wodEd.objects[idx];
      const s = starts.get(idx);
      o.w = Math.round(Math.max(20, Math.min(WOD_W + 200, s.w + dx)));
      o.h = Math.round(Math.max(20, Math.min(WOD_H + 200, s.h + dy)));    }
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
          const r = { x: WOD_OX + o.x * k, y: WOD_OY + o.y * k, w: o.w * k, h: o.h * k };
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
  const dtVisible = (document.getElementById('dt-stage')?.offsetParent ?? null) !== null;
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); if (dtVisible) dtUndo(); else wodUndo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); if (dtVisible) dtRedo(); else wodRedo(); }
  else if (key === 'c') { e.preventDefault(); if (dtVisible) dtCopy(); else wodCopy(); }
  else if (key === 'x') { e.preventDefault(); if (dtVisible) dtCopy(true); else wodCopy(true); }
  else if (key === 'v') { e.preventDefault(); if (dtVisible) dtPaste(); else wodPaste(); }
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

// тумблер «виджет включён» применяется сразу (без «Сохранить»)
$('#wod-enabled').addEventListener('change', async () => {
  try {
    await putSettings({ wordOfDay: { enabled: $('#wod-enabled').checked } });
    toast($('#wod-enabled').checked ? 'Слово дня включено 🔤' : 'Слово дня выключено');
  } catch (e) { toast(e.message, true); }
});

$('#wod-save').addEventListener('click', async () => {
  try {
    await putSettings({ wordOfDay: { enabled: $('#wod-enabled').checked, corner: $('#wod-corner').value, objects: wodEd.objects } });
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
  $('#wod-corner').value = wodEd.corner;
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

// ---------------- ⏱ «Таймер донатона»: редактор раскладки ----------------
// виджет по центру сверху: сцена = сам виджет 480×170 (координаты локальные)
// типы объектов: label (надпись) / clock (часы HH:MM:SS) / footer (нижняя строка) /
//               backdrop (подложка) / image (картинка)

const DT_W = 480;
const DT_H = 170;

let dtEd = { objects: [], enabled: false };
const DT_TYPE_RU = { label: '🏷 надпись', clock: '⏱ часы', footer: '📝 нижняя строка', backdrop: '🟪 подложка', image: '🖼 картинка' };
const dtHist = [];
const dtRedoStack = [];
let dtLastPush = 0;
let dtClipboard = [];

function dtDefault() {
  // карточка по центру сверху: подложка на весь виджет + надпись/часы/строка
  return [
    { id: 'backdrop-0', type: 'backdrop', x: 0, y: 0, w: DT_W, h: DT_H, opacity: 80, z: 1, color: '#0c0a19', radius: 18, rotate: 0, image: '', borderColor: '', borderWidth: 0 },
    { id: 'label-0', type: 'label', x: 20, y: 14, w: 440, h: 26, opacity: 85, z: 3, color: '#ffffff', text: 'стрим закончится через', fontSize: 16, radius: 0, rotate: 0, borderColor: '', borderWidth: 0 },
    { id: 'clock-0', type: 'clock', x: 20, y: 42, w: 440, h: 76, opacity: 100, z: 4, color: '#ff5a4d', fontSize: 60, radius: 0, rotate: 0, borderColor: '', borderWidth: 0 },
    { id: 'footer-0', type: 'footer', x: 20, y: 128, w: 440, h: 24, opacity: 80, z: 3, color: '#ffffff', text: 'продлить стрим: 30₽ за минуту', fontSize: 14, radius: 0, rotate: 0, borderColor: '', borderWidth: 0 },
  ];
}

function dtNorm(raw) {
  const c = raw ?? {};
  const objects = (Array.isArray(c.objects) && c.objects.length
    ? c.objects.filter((o) => o && ['label', 'clock', 'footer', 'backdrop', 'image'].includes(o.type))
    : dtDefault())
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
      fontFamily: String(o.fontFamily || '').slice(0, 80),
      visible: o.visible !== false,
      borderColor: String(o.borderColor || ''),
      borderWidth: Math.max(0, Math.min(12, Number(o.borderWidth) || 0)),
    }));
  return { enabled: Boolean(c.enabled), objects };
}

function dtK() { return 1; } // виджет маленький: превью = реальный размер
const DT_OX = 110; // зона виджета в сцене редактора
const DT_OY = 45;

function dtPush() {
  dtHist.push(JSON.stringify(dtEd.objects));
  if (dtHist.length > 60) dtHist.shift();
  dtRedoStack.length = 0;
  dtLastPush = Date.now();
}
function dtPushThrottled() { if (Date.now() - dtLastPush > 600) dtPush(); }
function dtUndo() {
  if (!dtHist.length) { toast('Отменять нечего'); return; }
  dtRedoStack.push(JSON.stringify(dtEd.objects));
  dtEd.objects = JSON.parse(dtHist.pop());
  dtSel = new Set();
  dtSelIdx = -1;
  dtRenderStage();
  dtRenderProps();
}
function dtRedo() {
  if (!dtRedoStack.length) { toast('Повторять нечего'); return; }
  dtHist.push(JSON.stringify(dtEd.objects));
  dtEd.objects = JSON.parse(dtRedoStack.pop());
  dtSel = new Set();
  dtSelIdx = -1;
  dtRenderStage();
  dtRenderProps();
}

let dtSel = new Set();
let dtSelIdx = 0;

function dtRenderStage() {
  const stage = $('#dt-stage');
  if (!stage) return;
  const sorted = dtEd.objects.map((o, i) => ({ o, i })).sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
  stage.innerHTML = '<div id="dt-zone"></div>';
  for (const { o, i } of sorted) {
    const div = document.createElement('div');
    div.className = `plp-obj plp-${o.type}${dtSel.has(i) ? ' sel' : ''}`;
    div.dataset.i = i;
    div.style.left = `${Math.round(DT_OX + o.x * dtK())}px`;
    div.style.top = `${Math.round(DT_OY + o.y * dtK())}px`;
    div.style.width = `${o.w * dtK()}px`;
    div.style.height = `${o.h * dtK()}px`;
    div.style.opacity = String(o.visible === false ? (o.opacity / 100) * 0.25 : o.opacity / 100);
    div.style.borderRadius = `${o.radius * dtK()}px`;
    div.style.transform = o.rotate ? `rotate(${o.rotate}deg)` : '';
    div.style.outline = o.visible === false ? '2px dashed #f59e0b' : '';
    div.title = o.visible === false ? 'скрыт (не виден на стриме)' : '';
    if (o.borderWidth) div.style.border = `${o.borderWidth}px solid ${o.borderColor || '#8b5cf6'}`;
    const fillText = o.type === 'label'
      ? (o.text || 'стрим закончится через')
      : o.type === 'clock'
        ? '1:23:45'
        : o.type === 'footer'
          ? (o.text || 'продлить стрим: 30₽ за минуту')
          : '';
    if (o.type === 'label' || o.type === 'clock' || o.type === 'footer') {
      div.style.color = o.color || '#ffffff';
      div.style.fontSize = `${o.fontSize * dtK()}px`;
      if (o.fontFamily) div.style.fontFamily = o.fontFamily;
      div.style.fontWeight = '700';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent = 'center';
      div.style.overflow = 'hidden';
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = fillText;
    } else if (o.type === 'backdrop') {
      if (o.image) div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
      else div.style.backgroundColor = o.color || '#0c0a19';
    } else if (o.type === 'image' && o.image) {
      div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
    }
    if (dtSel.size === 1 && i === dtSelIdx) {
      const h = document.createElement('div');
      h.className = 'plp-resize';
      div.appendChild(h);
    }
    stage.appendChild(div);
  }
}

function dtSnap(nx, ny, self) {
  const others = dtEd.objects.filter((_, j) => !dtSel.has(j));
  const anchorsX = [nx, nx + self.w / 2, nx + self.w];
  const anchorsY = [ny, ny + self.h / 2, ny + self.h];
  const targetsX = [{ pos: DT_W / 2, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.x, kind: 'obj' }, { pos: t.x + t.w / 2, kind: 'obj' }, { pos: t.x + t.w, kind: 'obj' }])];
  const targetsY = [{ pos: DT_H / 2, kind: 'scene' }, ...others.flatMap((t) => [{ pos: t.y, kind: 'obj' }, { pos: t.y + t.h / 2, kind: 'obj' }, { pos: t.y + t.h, kind: 'obj' }])];
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

function dtGuides({ v, h }) {
  $('#dt-guide-v')?.remove();
  $('#dt-guide-h')?.remove();
  if (!v && !h) return;
  const stage = $('#dt-stage');
  if (v) {
    const g = document.createElement('div');
    g.id = 'dt-guide-v';
    g.className = `plp-guide plp-guide-v ${v.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.left = `${DT_OX + v.pos * dtK()}px`;
    stage.appendChild(g);
  }
  if (h) {
    const g = document.createElement('div');
    g.id = 'dt-guide-h';
    g.className = `plp-guide plp-guide-h ${h.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
    g.style.top = `${DT_OY + h.pos * dtK()}px`;
    stage.appendChild(g);
  }
}

function dtRenderProps() {
  const chips = $('#dt-objects');
  const props = $('#dt-props');
  if (!chips || !props) return;
  chips.innerHTML = dtEd.objects.map((o, i) =>
    `<span class="chip${dtSel.has(i) ? ' sel' : ''}" data-i="${i}">${o.visible === false ? '🚫 ' : ''}${DT_TYPE_RU[o.type] ?? o.type}${(o.type === 'label' || o.type === 'footer') && o.text ? ` · ${esc(o.text.slice(0, 14))}` : ''}</span>`
  ).join('');
  if (!dtSel.size) {
    props.innerHTML = '<p class="hint">Клик — выделить · shift+клик — несколько · рамка по пустому месту · ctrl+z/y/c/x/v. «Часы» тикают сами — тут только стиль.</p>';
    return;
  }
  if (dtSel.size > 1) {
    props.innerHTML = `
      <p class="hint">выделено: ${dtSel.size} — тащатся вместе</p>
      <div class="rp-row">
        <button class="act ghost" id="dted-zup">▲ слой</button>
        <button class="act ghost" id="dted-zdown">▼ слой</button>
        <button class="act ghost" id="dted-del">🗑 удалить выбранное</button>
      </div>`;
    $('#dted-zup').addEventListener('click', () => { for (const i of dtSel) dtEd.objects[i].z = Math.min(30, dtEd.objects[i].z + 1); dtRenderStage(); dtRenderProps(); });
    $('#dted-zdown').addEventListener('click', () => { for (const i of dtSel) dtEd.objects[i].z = Math.max(0, dtEd.objects[i].z - 1); dtRenderStage(); dtRenderProps(); });
    $('#dted-del').addEventListener('click', () => {
      dtPush();
      dtEd.objects = dtEd.objects.filter((_, i) => !dtSel.has(i));
      dtSel = new Set();
      dtSelIdx = -1;
      dtRenderStage();
      dtRenderProps();
    });
    return;
  }
  const o = dtEd.objects[dtSelIdx];
  if (!o) { props.innerHTML = ''; return; }
  const row = (label, html) => `<label>${label}<div class="am-sound-row">${html}</div></label>`;
  let html = `
    <label class="hint"><input type="checkbox" id="dted-visible" ${o.visible === false ? '' : 'checked'} /> видимый на стриме</label>
    ${row('прозрачность', `<input type="range" id="dted-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="dted-op-val">${o.opacity}%</span>`)}
    ${row('поворот', `<input type="range" id="dted-rot" min="-15" max="15" value="${o.rotate}" /><span class="hint" id="dted-rot-val">${o.rotate}°</span>`)}
    <div class="rp-row">
      <label class="hint">слой:</label>
      <button class="act ghost" id="dted-zup" title="поднять">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="dted-zdown" title="опустить">▼</button>`;
  if (o.type === 'label' || o.type === 'clock' || o.type === 'footer') {
    html += row('текст', `<span class="hint">цвет</span><input type="color" id="dted-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="dted-fs" min="10" max="120" value="${o.fontSize}" style="width:56px" />`);
    html += row('семейство шрифта', `<select id="dted-font" style="max-width:260px">${fontOptions(o.fontFamily)}</select>`);
  }
  if (o.type === 'label' || o.type === 'footer') {
    html += `<label>надпись <input type="text" id="dted-text" class="wide" maxlength="60" value="${esc(o.text || '')}" /></label>`;
  }
  if (o.type === 'clock') {
    html += '<p class="hint">Время подставляется само: HH:MM:SS (часы — только если больше часа).</p>';
  }
  html += row('закругление', `<input type="number" id="dted-radius" min="0" max="120" value="${o.radius}" style="width:56px" />`);
  html += row('грань (обводка)', `<span class="hint">цвет</span><input type="color" id="dted-bcolor2" value="${esc(o.borderColor || '#8b5cf6')}" /><span class="hint">толщ</span><input type="range" id="dted-bw" min="0" max="12" value="${o.borderWidth}" style="width:90px" /><span class="hint" id="dted-bw-val">${o.borderWidth}px</span>`);
  if (o.type === 'backdrop' || o.type === 'image') {
    html += o.type === 'backdrop' ? `<label>цвет <input type="color" id="dted-bcolor" value="${esc(o.color || '#0c0a19')}" style="width:46px" /></label>` : '';
    html += `<label>картинка <select id="dted-img"></select></label>
      <div class="am-sound-row"><input type="file" id="dted-img-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="dted-img-up">⬆</button></div>`;
  }
  html += `<button class="act ghost" id="dted-del">🗑 Удалить объект</button></div>`;
  props.innerHTML = html;

  $('#dted-visible')?.addEventListener('change', () => { dtPushThrottled(); o.visible = $('#dted-visible').checked; dtRenderStage(); });
  $('#dted-font')?.addEventListener('change', () => { o.fontFamily = $('#dted-font').value; dtRenderStage(); });
  $('#dted-op').addEventListener('input', () => {
    o.opacity = Number($('#dted-op').value);
    $('#dted-op-val').textContent = `${o.opacity}%`;
    dtRenderStage();
  });
  $('#dted-rot').addEventListener('input', () => {
    o.rotate = Number($('#dted-rot').value);
    $('#dted-rot-val').textContent = `${o.rotate}°`;
    dtRenderStage();
  });
  $('#dted-zup').addEventListener('click', () => { o.z = Math.min(30, o.z + 1); dtRenderStage(); dtRenderProps(); });
  $('#dted-zdown').addEventListener('click', () => { o.z = Math.max(0, o.z - 1); dtRenderStage(); dtRenderProps(); });
  $('#dted-color')?.addEventListener('input', () => { o.color = $('#dted-color').value; dtRenderStage(); });
  $('#dted-fs')?.addEventListener('pointerdown', dtPushThrottled);
  $('#dted-fs')?.addEventListener('input', () => { o.fontSize = Number($('#dted-fs').value) || 22; dtRenderStage(); });
  $('#dted-text')?.addEventListener('input', () => { o.text = $('#dted-text').value; dtRenderStage(); dtRenderProps(); });
  $('#dted-radius')?.addEventListener('pointerdown', dtPushThrottled);
  $('#dted-radius')?.addEventListener('input', () => { o.radius = Number($('#dted-radius').value) || 0; dtRenderStage(); });
  $('#dted-bcolor2')?.addEventListener('input', () => { o.borderColor = $('#dted-bcolor2').value; dtRenderStage(); });
  $('#dted-bw')?.addEventListener('input', () => {
    o.borderWidth = Number($('#dted-bw').value) || 0;
    $('#dted-bw-val').textContent = `${o.borderWidth}px`;
    dtRenderStage();
  });
  $('#dted-bcolor')?.addEventListener('input', () => { o.color = $('#dted-bcolor').value; dtRenderStage(); });
  $('#dted-del').addEventListener('click', () => {
    dtPush();
    dtEd.objects.splice(dtSelIdx, 1);
    dtSelIdx = Math.max(-1, dtSelIdx - 1);
    dtSel = dtSelIdx >= 0 ? new Set([dtSelIdx]) : new Set();
    dtRenderStage();
    dtRenderProps();
  });

  const imgSel = $('#dted-img');
  if (imgSel) {
    api('/api/media').then(({ files }) => {
      const images = files.filter((f) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'apng'].includes(fileExt(f)));
      imgSel.innerHTML = ['<option value="">— не задано —</option>',
        ...images.map((f) => `<option value="${esc(f)}" ${o.image === f ? 'selected' : ''}>${esc(f)}</option>`)].join('');
    }).catch(() => {});
    imgSel.addEventListener('change', () => { dtPush(); o.image = imgSel.value; dtRenderStage(); dtRenderProps(); });
    $('#dted-img-up').addEventListener('click', async () => {
      const file = $('#dted-img-file')?.files?.[0];
      if (!file) { toast('Сначала выбери картинку', true); return; }
      const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || `HTTP ${r.status}`, true); return; }
      dtPush();
      o.image = file.name;
      toast('Картинка загружена ✅');
      dtRenderStage();
      dtRenderProps();
    });
  }
}

// drag/рамка/магнит — своя сцена (как у wod/plp)
(() => {
  const stage = $('#dt-stage');
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
    for (const i of dtSel) starts.set(i, { ...dtEd.objects[i] });
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
      dtGuides({ v: null, h: null });
      e.preventDefault();
      return;
    }
    idx = Number(obj.dataset.i);
    dtSelIdx = idx;
    if (e.shiftKey) {
      if (dtSel.has(idx)) dtSel.delete(idx);
      else dtSel.add(idx);
    } else if (!dtSel.has(idx)) {
      dtSel = new Set([idx]);
    }
    if (!dtSel.size) dtSel = new Set([idx]);
    dtSelIdx = dtSel.has(idx) ? idx : [...dtSel][0];
    mode = (handle && dtSel.size === 1) ? 'resize' : 'move';
    snapshot();
    dtPush();
    dtRenderStage();
    dtRenderProps();
    e.preventDefault();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const k = dtK();
    moved = true;
    if (mode === 'band') {
      const r = stage.getBoundingClientRect();
      band = {
        x: Math.min(grabX, e.clientX) - r.left,
        y: Math.min(grabY, e.clientY) - r.top,
        w: Math.abs(e.clientX - grabX),
        h: Math.abs(e.clientY - grabY),
      };
      $('#dt-band')?.remove();
      const b = document.createElement('div');
      b.id = 'dt-band';
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
      const snap = dtSnap(anchor.x + dx, anchor.y + dy, anchor);
      const shiftX = snap.x - (anchor.x + dx);
      const shiftY = snap.y - (anchor.y + dy);
      for (const [i, s] of starts) {
        const o = dtEd.objects[i];
        o.x = Math.round(Math.max(-110, Math.min(DT_W + 110, s.x + dx + shiftX)));
        o.y = Math.round(Math.max(-45, Math.min(DT_H + 45, s.y + dy + shiftY)));
      }
      pendingGuides = snap.guides;
    } else {
      const o = dtEd.objects[idx];
      const s = starts.get(idx);
      o.w = Math.round(Math.max(20, Math.min(DT_W + 200, s.w + dx)));
      o.h = Math.round(Math.max(20, Math.min(DT_H + 200, s.h + dy)));
    }
    dtRenderStage();
    dtRenderProps();
    if (pendingGuides) { dtGuides(pendingGuides); pendingGuides = null; }
  });

  const stop = () => {
    if (mode === 'band') {
      $('#dt-band')?.remove();
      if (!moved && !bandShift) {
        dtSel = new Set();
        dtSelIdx = -1;
      } else if (band && (band.w > 3 || band.h > 3)) {
        dtSel = new Set();
        const k = dtK();
        for (const [i, o] of dtEd.objects.entries()) {
          const r = { x: DT_OX + o.x * k, y: DT_OY + o.y * k, w: o.w * k, h: o.h * k };
          if (r.x < band.x + band.w && r.x + r.w > band.x && r.y < band.y + band.h && r.y + r.h > band.y) dtSel.add(i);
        }
        if (dtSel.size) dtSelIdx = [...dtSel].at(-1);
      }
      dtRenderStage();
      dtRenderProps();
    }
    mode = null;
    starts = null;
    band = null;
    dtGuides({ v: null, h: null });
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
})();

$('#dt-objects').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-i]');
  if (!chip) return;
  const i = Number(chip.dataset.i);
  if (e.shiftKey) {
    if (dtSel.has(i)) dtSel.delete(i);
    else dtSel.add(i);
  } else dtSel = new Set([i]);
  dtSelIdx = i;
  dtRenderStage();
  dtRenderProps();
});

$('#dt-props').addEventListener('pointerdown', dtPushThrottled);

function dtCopy(cut = false) {
  if (!dtSel.size) { toast('Сначала выдели объект(ы)', true); return; }
  dtClipboard = [...dtSel].map((i) => JSON.parse(JSON.stringify(dtEd.objects[i])));
  if (cut) {
    dtPush();
    dtEd.objects = dtEd.objects.filter((_, i) => !dtSel.has(i));
    dtSel = new Set();
    dtSelIdx = -1;
    dtRenderStage();
    dtRenderProps();
    toast(`Вырезано: ${dtClipboard.length}`);
  } else toast(`Скопировано: ${dtClipboard.length}`);
}
function dtPaste() {
  if (!dtClipboard?.length) { toast('Буфер пуст', true); return; }
  dtPush();
  const pasted = [];
  for (const [n, o] of dtClipboard.entries()) {
    const c = { ...o, x: o.x + 30, y: o.y + 30 };
    c.id = `${c.type}-${Date.now()}-${n}`;
    dtEd.objects.push(c);
    pasted.push(dtEd.objects.length - 1);
  }
  dtSel = new Set(pasted);
  dtSelIdx = pasted.at(-1);
  dtRenderStage();
  dtRenderProps();
  toast(`Вставлено: ${pasted.length}`);
}

$('#dt-widget-add').addEventListener('click', () => $('#dt-image-file').click());
$('#dt-image-file').addEventListener('change', async () => {
  const file = $('#dt-image-file')?.files?.[0];
  if (!file) return;
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const zMax = Math.max(0, ...dtEd.objects.map((o) => o.z));
    dtPush();
    dtEd.objects.push({ id: `image-${Date.now()}`, type: 'image', x: 1500, y: 200, w: 340, h: 220, opacity: 100, z: zMax + 1, image: file.name, radius: 0, rotate: 0 });
    dtSelIdx = dtEd.objects.length - 1;
    dtSel = new Set([dtSelIdx]);
    $('#dt-image-file').value = '';
    dtRenderStage();
    dtRenderProps();
    toast('Элемент добавлен 🖼');
  } catch (e) { toast(e.message, true); }
});
$('#dt-widget-reset').addEventListener('click', () => {
  dtPush();
  dtEd.objects = dtDefault();
  dtSelIdx = 0;
  dtSel = new Set([0]);
  dtRenderStage();
  dtRenderProps();
  toast('Дефолтная раскладка (не забудь сохранить)');
});

$('#dt-save-layout').addEventListener('click', async () => {
  try {
    await putSettings({ donaTimer: { enabled: $('#dt-enabled').checked, objects: dtEd.objects } });
    toast('Раскладка таймера сохранена ✅');
  } catch (e) { toast(e.message, true); }
});

async function loadDonaTimerLayout() {
  const st = await api('/api/settings');
  dtEd = dtNorm(st.donaTimer ?? {});
  $('#dt-enabled').checked = dtEd.enabled;
  dtSelIdx = 0;
  dtSel = new Set(dtEd.objects.length ? [0] : []);
  dtRenderStage();
  dtRenderProps();
}
loadDonaTimerLayout().catch(() => {});

// ---------------- 🎰 Рулетка (за баллы канала) ----------------

let whItems = [];
let whOverlay = { x: 760, y: 340, size: 400 };
// state рулетки: объекты редактора (движок держит ссылку на массив)
let whEd = []; // wheel + text + картинки-декор

function whK() { const s = $('#wh-stage'); return s ? s.clientWidth / 1920 : 0.25; }

async function loadWheel() {
  const st = await api('/api/settings');
  const w = st.wheel ?? {};
  whOverlay = w.overlay ?? { size: 400 }; // без x/y = колесо по центру сцены в редакторе
  $('#wh-enabled').checked = w.enabled !== false;
  $('#wh-mode').value = w.mode ?? 'reward';
  $('#wh-reward').value = w.rewardName ?? 'колесо';
  $('#wh-cooldown').value = Math.round((w.cooldown ?? 60) / 60);
  whItems = Array.isArray(w.items) ? w.items.map((x) => ({ ...x })) : [];
  $('#wh-duration').value = whOverlay.duration ?? 8;
  $('#wh-template').value = whOverlay.winnerTemplate ?? '🏆 {user} → {label}';
  renderWheelItems();
  renderWheelSoundSelect(whOverlay.spinSound ?? '');
  whEdLoad(whOverlay);
}

function whTotal() {
  return whItems.reduce((s, x) => s + Math.max(1, Number(x.weight) || 1), 0);
}

function whPct(weight, total) {
  const t = total ?? whTotal();
  return t > 0 ? (Math.max(1, Number(weight) || 1) / t) * 100 : 0;
}

/** Обновить поле «шанс, %» в каждой строке (кроме поля, в котором сейчас печатаем). */
function whRefreshPcts(except) {
  document.querySelectorAll('#wh-body tr[data-i]').forEach((row) => {
    const it = whItems[Number(row.dataset.i)];
    const el = row.querySelector('.wh-pct');
    if (!it || !el || el === except) return;
    el.value = whPct(it.weight).toFixed(2);
  });
}

function renderWheelItems() {
  const palette = ['#8b5cf6', '#22c55e', '#eab308', '#38bdf8', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];
  const total = whTotal();
  $('#wh-body').innerHTML = whItems.map((it, i) => {
    const w = Math.max(1, Number(it.weight) || 1);
    const pct = total > 0 ? (w / total) * 100 : 0;
    return `
    <tr data-i="${i}">
      <td class="cellresp"><input class="wh-label" value="${esc(it.label || '')}" maxlength="60" /></td>
      <td class="cellcd wh-w-cell">
        <input class="wh-weight" type="number" min="1" step="1" value="${w}" style="width:62px" title="вес: печатай число, крути колёсиком мыши (Shift = ×10) или стрелками ↑↓" />
        <input class="wh-pct" type="number" min="0" max="100" step="0.01" value="${pct.toFixed(2)}" style="width:62px" title="шанс выпадения, %: печатай вручную — вес пересчитается сам" />%
      </td>
      <td class="cellcd"><input class="wh-color" type="color" value="${esc(it.color || palette[i % palette.length])}" /></td>
      <td><button class="act ghost wh-del" title="удалить">🗑</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="hint">Вариантов нет — добавь первый</td></tr>';
  try { whEngine.rerender(); } catch {}
}

async function renderWheelSoundSelect(selected) {
  try {
    const { files } = await api('/api/media');
    const sounds = files.filter((f) => ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(fileExt(f)));
    $('#wh-sound').innerHTML = ['<option value="">— без тика —</option>',
      ...sounds.map((f) => `<option value="${esc(f)}" ${f === selected ? 'selected' : ''}>${esc(f)}</option>`)].join('');
  } catch {}
}

// ---------- редактор раскладки рулетки: типы + EditorEngine ----------
// движок (рамка/магниты/история/копипаст/слои) — editor-engine.js, тот же,
// что у редактора виджета музыки; рулетка подключает только СВОИ типы объектов

/** Сектора превью колеса — conic-gradient по весам вариантов (как на оверлее). */
function whMockGradient() {
  const palette = ['#8b5cf6', '#22c55e', '#eab308', '#38bdf8', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];
  const items = whItems.filter((x) => x.label);
  if (!items.length) return '';
  const total = items.reduce((s, x) => s + Math.max(1, Number(x.weight) || 1), 0);
  let acc = 0;
  const stops = items.map((x, i) => {
    const from = (acc / total) * 360;
    acc += Math.max(1, Number(x.weight) || 1);
    const to = (acc / total) * 360;
    const col = x.color || palette[i % palette.length];
    return `${col} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function whEdNorm(o = {}) {
  const size = Math.max(100, Math.min(800, Math.round(Number(o.size) || 400)));
  // пустые настройки = дефолт по центру сцены (960×540), а не в углу
  const cx = o.x == null ? 960 : Math.max(0, Math.min(1920, Math.round(Number(o.x) || 960)));
  const cy = o.y == null ? 540 : Math.max(0, Math.min(1080, Math.round(Number(o.y) || 540)));
  const tdx = o.textDX == null ? 0 : (Number(o.textDX) || 0);
  const tdy = o.textDY == null
    ? (size / 2 + 8 + Math.max(16, size * 0.065) * 0.6)
    : (Number(o.textDY) || 0);
  const tfs = Math.max(0, Math.round(Number(o.textFontSize) || 0));
  const bw = Math.max(60, Math.round(Number(o.textW) || size * 1.1));
  const thEst = (tfs || Math.max(16, Math.round(size * 0.065))) * 1.3;
  const objects = [
    { id: 'wheel-0', type: 'wheel', x: cx - size / 2, y: cy - size / 2, w: size, h: size, opacity: 100, z: 5,
      arrowAngle: Math.max(0, Math.min(359, Math.round(Number(o.arrowAngle) || 0))),
      arrowRotate: Math.max(-180, Math.min(180, Math.round(Number(o.arrowRotate) || 0))) },
    { id: 'text-0', type: 'text', x: cx + tdx - bw / 2, y: cy + tdy - thEst / 2, w: bw, h: Math.round(thEst), fontSize: tfs, opacity: Math.max(0, Math.min(100, Number(o.textOpacity ?? 100))), z: 6, color: String(o.textColor || '#ffffff').slice(0, 20) },
  ];
  for (const im of (Array.isArray(o.images) ? o.images : [])) {
    if (!im || im.type !== 'image') continue;
    const num = (v, mn, mx, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(mn, Math.min(mx, Math.round(n))) : d; };
    objects.push({
      id: String(im.id || `image-${objects.length}`).slice(0, 40), type: 'image',
      x: num(im.x, -500, 2500, 660), y: num(im.y, -500, 2500, 120),
      w: num(im.w, 20, 2500, 400), h: num(im.h, 20, 2500, 267),
      opacity: num(im.opacity, 0, 100, 100), z: num(im.z, 0, 30, 7),
      image: String(im.image || '').slice(0, 120), radius: num(im.radius, 0, 120, 0),
      borderColor: String(im.borderColor || '').slice(0, 20), borderWidth: num(im.borderWidth, 0, 12, 0),
    });
  }
  return objects;
}

/** Объекты редактора → настройки оверлея (whOverlay — источник правды для сохранения). */
function whSync() {
  const wheel = whEd.find((x) => x.type === 'wheel');
  const text = whEd.find((x) => x.type === 'text');
  const images = whEd.filter((x) => x.type === 'image');
  if (wheel) {
    whOverlay.x = Math.round(wheel.x + wheel.w / 2);
    whOverlay.y = Math.round(wheel.y + wheel.h / 2);
    whOverlay.size = Math.round(wheel.w);
    whOverlay.arrowAngle = Math.round(wheel.arrowAngle);
    whOverlay.arrowRotate = Math.round(wheel.arrowRotate);
  }
  if (text && wheel) {
    whOverlay.textDX = Math.round(text.x + text.w / 2 - (wheel.x + wheel.w / 2));
    whOverlay.textDY = Math.round(text.y + text.h / 2 - (wheel.y + wheel.h / 2));
    whOverlay.textW = Math.round(text.w);
    whOverlay.textFontSize = Number(text.fontSize) || 0;
    whOverlay.textFontFamily = String(text.fontFamily || '');
    whOverlay.textColor = text.color || '#ffffff';
    whOverlay.textOpacity = text.opacity ?? 100;
  }
  whOverlay.images = images;
}

function whTextMockText() {
  return (whOverlay.winnerTemplate || '🏆 {user} → {label}')
    .replaceAll('{user}', 'юзер').replaceAll('{label}', 'вариант');
}

const whEngine = EditorEngine.create({
  stage: $('#wh-stage'),
  chips: $('#wh-objects'),
  props: $('#wh-props'),
  objects: whEd,
  k: whK,
  onChange: whSync,
  hotkeyGate: () => {
    const st = $('#wh-stage');
    return Boolean(st?.closest('details')?.open) && Boolean(st?.offsetParent);
  },
  propsHint: '<p class="hint">Стрелку тянуть прямо в превью: за неё — едет по кругу, за ↻ — вращается сама. Слой картинки ≥6 — над колесом, ≤4 — под.</p>',
  onDblclick: (o, e) => {
    if (e.target.closest('.wh-arrow-mock')) {
      o.arrowRotate = 0;
      whSync();
      whEngine.rerender();
      return;
    }
    if (o.type === 'text') {
      const wheel = whEd.find((x) => x.type === 'wheel');
      if (!wheel) return;
      o.x = Math.round(wheel.x + wheel.w / 2 - o.w / 2);
      o.y = Math.round(wheel.y + wheel.h / 2 + 8 + Math.max(16, wheel.w * 0.065) * 0.6 - o.h / 2);
      whSync();
      whEngine.rerender();
      toast('Текст вернулся под колесо');
    }
  },
  types: {
    // ---------- 🎡 колесо с стрелкой ----------
    wheel: {
      label: '🎡 колесо',
      copyable: false, // одно на рулетку
      render: (o, div, api) => {
        div.classList.add('wh-wheel-mock');
        div.style.borderRadius = '50%';
        div.style.background = whMockGradient() || 'linear-gradient(0deg, #8b5cf6, #8b5cf6)';
        const kk = api.k();
        const a = ((Number(o.arrowAngle) || 0) * Math.PI) / 180;
        const rot = ((Number(o.arrowRotate) || 0) * Math.PI) / 180;
        const rPx = (o.w * kk) / 2;
        // стрелка прижата к ободу снаружи, носиком от центра (та же формула, что на оверлее: r + 10)
        const ax = rPx + Math.cos(a + Math.PI) * (rPx + 10);
        const ay = rPx + Math.sin(a + Math.PI) * (rPx + 10);
        const arrow = document.createElement('div');
        arrow.className = 'wh-arrow-mock';
        arrow.style.left = `${Math.round(ax - 14)}px`;
        arrow.style.top = `${Math.round(ay - 11)}px`;
        arrow.style.transform = `rotate(${a + Math.PI / 2 + rot}rad)`;
        arrow.title = 'тяни — едет по кругу; за ↻ — вращается сама; двойной клик — сброс поворота';
        div.appendChild(arrow);
        const nx = -Math.cos(a), ny = -Math.sin(a);
        const cnx = nx * Math.cos(rot) - ny * Math.sin(rot);
        const cny = nx * Math.sin(rot) + ny * Math.cos(rot);
        const rh = document.createElement('div');
        rh.className = 'wh-rot-handle';
        rh.textContent = '↻';
        rh.title = 'вращение стрелки — тяни по кругу';
        rh.style.left = `${Math.round(ax + cnx * 34)}px`;
        rh.style.top = `${Math.round(ay + cny * 34)}px`;
        // ручка видна всегда; без выделения — чуть приглушена
        if (!api.getSelection().has(whEd.indexOf(o))) rh.style.opacity = '.75';
        div.appendChild(rh);
        // счётчик вариантов в левом верхнем углу колеса
        const cnt = whItems.filter((x) => x.label).length;
        const cntWord = (cnt % 10 === 1 && cnt % 100 !== 11) ? 'вариант'
          : ([2, 3, 4].includes(cnt % 10) && ![12, 13, 14].includes(cnt % 100)) ? 'варианта'
          : 'вариантов';
        const badge = document.createElement('div');
        badge.className = 'wh-count-badge';
        badge.textContent = `${cnt} ${cntWord}`;
        div.appendChild(badge);
      },
      resize: (o, s, dx) => { // круг: сторона растёт в обе стороны, форма не меняется
        o.w = Math.round(Math.max(100, Math.min(800, s.w + dx * 2)));
        o.h = o.w;
      },
      handles: [
        { // стрелка едет по кругу вокруг колеса
          selector: '.wh-arrow-mock',
          drag: (o, api, ev) => {
            if (!ev) return;
            const { sx, sy } = api.scene(ev);
            const cx = o.x + o.w / 2;
            const cy = o.y + o.h / 2;
            const deg = Math.round(((Math.atan2(sy - cy, sx - cx) * 180) / Math.PI + 180 + 360) % 360);
            o.arrowAngle = Math.max(0, Math.min(359, deg));
            api.setHint({ x: cx, y: cy, text: `${o.arrowAngle}°` });
            whSync();
            api.rerender();
          },
        },
        { // ↻: стрелка вращается сама (носик смотрит на курсор)
          selector: '.wh-rot-handle',
          drag: (o, api, ev) => {
            if (!ev) return;
            const { sx, sy } = api.scene(ev);
            const aRad = ((Number(o.arrowAngle) || 0) * Math.PI) / 180;
            const cx = o.x + o.w / 2 + Math.cos(aRad + Math.PI) * (o.w / 2 + 10);
            const cy = o.y + o.h / 2 + Math.sin(aRad + Math.PI) * (o.w / 2 + 10);
            let d = (Math.atan2(sy - cy, sx - cx) - (aRad + Math.PI)) * 180 / Math.PI;
            d = ((Math.round(d) % 360) + 540) % 360 - 180;
            o.arrowRotate = d;
            api.setHint({ x: cx, y: cy, text: `↻ ${d}°` });
            whSync();
            api.rerender();
          },
        },
      ],
      props: (o) => `
        <label>размер, px
          <div class="am-sound-row"><input type="number" id="whp-w" min="100" max="800" value="${o.w}" style="width:70px" /><span class="hint">растягивается и ручкой в превью</span></div>
        </label>
        <label>стрелка: угол по кругу
          <div class="am-sound-row"><input type="number" id="whp-ang" min="0" max="359" value="${o.arrowAngle}" style="width:70px" /><span class="hint">0=лево, 90=верх</span></div>
        </label>
        <label>стрелка: свой поворот
          <div class="am-sound-row"><input type="number" id="whp-rot" min="-180" max="180" value="${o.arrowRotate}" style="width:70px" /><span class="hint">°</span></div>
        </label>`,
      bind: (o, api) => {
        const num = (id, fn, valText) => {
          const elr = $(id);
          if (!elr) return;
          elr.addEventListener('input', () => {
            api.pushThrottled();
            fn(elr);
            whSync();
            api.rerender();
          });
        };
        num('#whp-w', (el) => { o.w = Math.max(100, Math.min(800, Number(el.value) || 100)); o.h = o.w; });
        num('#whp-ang', (el) => { o.arrowAngle = Math.max(0, Math.min(359, Number(el.value) || 0)); });
        num('#whp-rot', (el) => { o.arrowRotate = Math.max(-180, Math.min(180, Number(el.value) || 0)); });
      },
    },
    // ---------- 📝 текст победителя ----------
    text: {
      label: '📝 текст',
      copyable: false, // один на рулетку
      render: (o, div, api) => {
        div.classList.add('wh-text-mock');
        const wheel = whEd.find((x) => x.type === 'wheel');
        div.style.fontSize = `${Math.round((Number(o.fontSize) || Math.max(16, (wheel ? wheel.w : 400) * 0.065)) * api.k())}px`;
        div.style.color = o.color || '#ffffff';
        if (o.fontFamily) div.style.fontFamily = o.fontFamily;
        div.textContent = whTextMockText();
        div.title = 'тяни куда угодно, уголок — ширина окна; двойной клик — вернуть под колесо';
        // высоту уточняем по содержимому (перенос строк) — для рамки выделения и магнитов
        setTimeout(() => {
          const r = div.getBoundingClientRect();
          if (r.height && api.k() > 0) {
            const h = Math.round(r.height / api.k());
            if (h !== o.h) o.h = h;
          }
        }, 0);
      },
      resize: (o, s, dx) => { // окно шире/уже; высота — по тексту
        o.w = Math.round(Math.max(60, Math.min(2500, s.w + dx)));
      },
      props: (o) => `
        <label>шрифт, px
          <div class="am-sound-row"><input type="number" id="whp-fs" min="0" max="150" value="${Number(o.fontSize) || 0}" style="width:70px" title="0 = автоподбор от размера колеса" /><span class="hint">${Number(o.fontSize) ? '' : 'авто'}</span></div>
        </label>
        <label>семейство шрифта
          <div class="am-sound-row"><select id="whp-font" style="max-width:260px">${fontOptions(o.fontFamily)}</select></div>
        </label>
        <label>окно текста
          <div class="am-sound-row"><span class="hint">растягивается ручкой в превью (длинный текст — переносится строками)</span></div>
        </label>
        <label>цвет
          <div class="am-sound-row"><input type="color" id="whp-color" value="${esc(o.color || '#ffffff')}" /> <input type="range" id="whp-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="whp-op-val">${o.opacity}%</span></div>
        </label>`,
      bind: (o, api) => {
        const num = (id, fn, valText) => {
          const elr = $(id);
          if (!elr) return;
          elr.addEventListener('input', () => {
            api.pushThrottled();
            fn(elr);
            whSync();
            api.rerender();
          });
        };
        num('#whp-fs', (el) => { o.fontSize = Math.max(0, Math.min(150, Number(el.value) || 0)); });
        $('#whp-font')?.addEventListener('change', () => { o.fontFamily = $('#whp-font').value; whSync(); api.rerender(); });
        $('#whp-color')?.addEventListener('input', () => { o.color = $('#whp-color').value; whSync(); api.rerender(); });
        $('#whp-op')?.addEventListener('input', () => { o.opacity = Number($('#whp-op').value); $('#whp-op-val').textContent = `${o.opacity}%`; whSync(); api.rerender(); });
      },
    },
    // ---------- 🖼 картинка-декор ----------
    image: {
      label: '🖼 картинка',
      render: (o, div, api) => {
        div.classList.add('wh-obj-image');
        div.style.borderRadius = `${(o.radius || 0) * api.k()}px`;
        if (o.image) div.style.backgroundImage = `url(/media/${encodeURIComponent(o.image)})`;
      },
      props: (o) => `
        <label>прозрачность
          <div class="am-sound-row"><input type="range" id="whp-iop" min="0" max="100" value="${o.opacity}" /><span class="hint" id="whp-iop-val">${o.opacity}%</span></div>
        </label>
        <label>грань (обводка)
          <div class="am-sound-row"><span class="hint">цвет</span><input type="color" id="whp-b2color" value="${esc(o.borderColor || '#8b5cf6')}" /><span class="hint">толщ</span><input type="range" id="whp-bw" min="0" max="12" value="${o.borderWidth ?? 0}" style="width:90px" /><span class="hint" id="whp-bw-val">${o.borderWidth ?? 0}px</span></div>
        </label>
        <label>вид
          <div class="am-sound-row"><span class="hint">углы</span><input type="number" id="whp-radius" min="0" max="120" value="${o.radius || 0}" style="width:56px" /></div>
        </label>
        <label>картинка <select id="whp-img"></select></label>
        <div class="am-sound-row"><input type="file" id="whp-img-file" accept="image/png,image/jpeg,image/webp/image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="whp-img-up" title="загрузить и поставить сюда">⬆</button></div>`,
      bind: (o, api) => {
        const num = (id, valId, fn, valText) => {
          const elr = $(id);
          if (!elr) return;
          elr.addEventListener('input', () => {
            api.pushThrottled();
            fn(elr);
            const v = $(valId);
            if (v) v.textContent = valText ? valText(elr) : elr.value;
            whSync();
            api.rerender();
          });
        };
        num('#whp-iop', '#whp-iop-val', (el) => { o.opacity = Math.max(0, Math.min(100, Number(el.value) || 0)); });
        num('#whp-bw', '#whp-bw-val', (el) => { o.borderWidth = Math.max(0, Math.min(12, Number(el.value) || 0)); }, (el) => `${el.value}px`);
        num('#whp-radius', null, (el) => { o.radius = Math.max(0, Math.min(120, Number(el.value) || 0)); });
        $('#whp-b2color')?.addEventListener('input', () => { o.borderColor = $('#whp-b2color').value; whSync(); api.rerender(); });
        const imgSel = $('#whp-img');
        if (imgSel) {
          api('/api/media').then(({ files }) => {
            const images = files.filter((f) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'apng'].includes(fileExt(f)));
            imgSel.innerHTML = ['<option value="">— не задано —</option>',
              ...images.map((f) => `<option value="${esc(f)}" ${o.image === f ? 'selected' : ''}>${esc(f)}</option>`)].join('');
          }).catch(() => {});
          imgSel.addEventListener('change', () => { o.image = imgSel.value; whSync(); api.rerender(); api.renderProps(); });
        }
        $('#whp-img-up')?.addEventListener('click', async () => {
          const file = $('#whp-img-file')?.files?.[0];
          if (!file) { toast('Сначала выбери картинку', true); return; }
          try {
            const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
              method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            o.image = file.name;
            whSync();
            toast('Картинка загружена и поставлена ✅');
            api.rerender();
            api.renderProps();
          } catch (e) { toast(e.message, true); }
        });
      },
    },
  },
});

/** Загрузка настроек оверлея в редактор (без смены массива — движок держит ссылку).
 *  Если секция ещё скрыта (details закрыт / вкладка не активна) — stage имеет
 *  нулевую ширину и рендер выйдет в левый верхний угол; откладываем до открытия. */
function whEdLoad(o = {}) {
  const fresh = whEdNorm(o);
  whEd.length = 0;
  whEd.push(...fresh);
  const st = $('#wh-stage');
  const visible = st && st.clientWidth > 0 && Boolean(st.offsetParent);
  if (visible) {
    whEngine.rerender();
    whEngine.select(0);
  }
  // невидимо: ничего не рисуем — toggle вкладки/details вызовет whEdLoad заново
}

// ---------- тулбар: своя картинка + SVG-шаблон ----------
$('#wh-widget-add').addEventListener('click', () => $('#wh-image-file').click());
$('#wh-image-file').addEventListener('change', async () => {
  const file = $('#wh-image-file')?.files?.[0];
  if (!file) return;
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    whEngine.push();
    whEd.push({ id: `image-${Date.now()}`, type: 'image', x: 660, y: 120, w: 400, h: 267, opacity: 100, z: Math.max(5, ...whEd.map((x) => x.z ?? 1)) + 1, image: file.name, radius: 0, borderColor: '', borderWidth: 0 });
    $('#wh-image-file').value = '';
    whSync();
    whEngine.select(whEd.length - 1);
    whEngine.rerender();
    toast('Картинка добавлена — двигай её в превью 🖼');
  } catch (e) { toast(e.message, true); }
});

// ⬇ SVG-шаблон: зоны всех объектов с честными размерами
$('#wh-template-btn').addEventListener('click', () => {
  const colors = { wheel: '#8b5cf6', text: '#eab308', image: '#38bdf8' };
  const shapes = whEd.map((o) => o.type === 'wheel'
    ? `<circle cx="${o.x + o.w / 2}" cy="${o.y + o.h / 2}" r="${o.w / 2}" fill="none" stroke="${colors[o.type]}" stroke-width="4" stroke-dasharray="14 8"/><text x="${o.x + 12}" y="${Math.max(20, o.y - 8)}" fill="${colors[o.type]}" font-size="22" font-family="sans-serif">${o.type} ${o.w}×${o.h} px, слой ${o.z}</text>`
    : `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" fill="none" stroke="${colors[o.type]}" stroke-width="4" stroke-dasharray="14 8" rx="${o.radius || 0}"/><text x="${o.x + 8}" y="${Math.max(20, o.y - 8)}" fill="${colors[o.type]}" font-size="22" font-family="sans-serif">${o.type} ${o.w}×${o.h} px, слой ${o.z}</text>`).join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <title>Шаблон оверлея рулетки</title>
  ${shapes}
</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'roulette-template.svg';
  a.click();
  URL.revokeObjectURL(url);
  toast('Шаблон скачан: зоны всех объектов с их размерами');
});



$('#wh-add').addEventListener('click', () => {
  const label = $('#wh-add-label').value.trim();
  const weight = Math.max(1, Number($('#wh-add-weight').value) || 10);
  if (!label) { toast('Напиши вариант', true); return; }
  if (whItems.length >= 12) { toast('Максимум 12 вариантов', true); return; }
  whItems.push({ label, weight, color: '' });
  $('#wh-add-label').value = '';
  renderWheelItems();
});
$('#wh-add-label').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#wh-add').click(); });

// шаблон победителя печатаем — превью текста под колесом обновляется сразу
$('#wh-template').addEventListener('input', () => {
  whOverlay.winnerTemplate = $('#wh-template').value;
  whEngine.rerender();
});

$('#wh-body').addEventListener('click', (e) => {
  if (!e.target.classList.contains('wh-del')) return;
  const row = e.target.closest('tr[data-i]');
  whItems.splice(Number(row.dataset.i), 1);
  renderWheelItems();
});
$('#wh-body').addEventListener('input', (e) => {
  const row = e.target.closest('tr[data-i]');
  if (!row) return;
  const it = whItems[Number(row.dataset.i)];
  if (e.target.classList.contains('wh-label')) it.label = e.target.value;
  if (e.target.classList.contains('wh-weight')) {
    const n = Math.round(Number(e.target.value));
    it.weight = Number.isFinite(n) && n > 0 ? n : 1;
    whRefreshPcts(e.target); // шансы остальных вязаных строк обновились
  }
  if (e.target.classList.contains('wh-color')) it.color = e.target.value;
});

// вес набран/вышел из поля — прибираем значение в поле (min 1)
$('#wh-body').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-i]');
  if (!row) return;
  const it = whItems[Number(row.dataset.i)];
  if (!it) return;
  if (e.target.classList.contains('wh-weight')) {
    it.weight = Math.max(1, Math.round(Number(e.target.value)) || 1);
    e.target.value = String(it.weight);
    whRefreshPcts();
  }
  // шанс, % напечатан вручную → пересчёт веса: pct = w/(others+w) → w = pct·others/(100−pct)
  if (e.target.classList.contains('wh-pct')) {
    const pct = Number(e.target.value);
    const others = whTotal() - Math.max(1, Number(it.weight) || 1);
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100 || !Number.isFinite(others) || others <= 0) {
      whRefreshPcts(); // мимо — откатили поле
      return;
    }
    it.weight = Math.max(1, Math.round((pct / (100 - pct)) * others));
    row.querySelector('.wh-weight').value = String(it.weight);
    whRefreshPcts(e.target);
    const back = whPct(it.weight);
    e.target.value = back.toFixed(2); // фактический шанс после округления веса
  }
});

// колёсико мыши над весом: ±1 (Shift = ±10)
$('#wh-body').addEventListener('wheel', (e) => {
  const el = e.target.closest('.wh-weight');
  const row = el?.closest('tr[data-i]');
  if (!row) return; // крутим мимо поля веса — пусть страница скроллится как обычно
  e.preventDefault();
  const it = whItems[Number(row.dataset.i)];
  const step = (e.shiftKey ? 10 : 1) * (e.deltaY < 0 ? 1 : -1);
  it.weight = Math.max(1, (Math.max(1, Number(it.weight) || 1)) + step);
  el.value = String(it.weight);
  whRefreshPcts();
}, { passive: false });

// тумблер «включено» применяется сразу (без «Сохранить») — F5 не вернёт старое состояние
$('#wh-enabled').addEventListener('change', async () => {
  try {
    whSync();
    await putSettings({ wheel: { enabled: $('#wh-enabled').checked } });
    toast($('#wh-enabled').checked ? 'Рулетка включена 🎡' : 'Рулетка выключена');
  } catch (e) { toast(e.message, true); }
});

$('#wh-save').addEventListener('click', async () => {
  try {
    whSync(); // объекты редактора → в настройки оверлея
    await putSettings({
      wheel: {
        enabled: $('#wh-enabled').checked,
        mode: $('#wh-mode').value,
        rewardName: $('#wh-reward').value.trim(),
        cooldown: Math.round((Number($('#wh-cooldown').value) || 0) * 60),
        items: whItems.filter((x) => x.label && x.weight > 0),
        overlay: {
          ...whOverlay,
          duration: Number($('#wh-duration').value) || 8,
          spinSound: $('#wh-sound').value,
          winnerTemplate: $('#wh-template').value,
        },
      },
    });
    toast('Рулетка сохранена ✅');
  } catch (e) { toast(e.message, true); }
});

$('#wh-test').addEventListener('click', async () => {
  try {
    await api('/api/actions/wheeltest', { method: 'POST', body: '{}' });
    toast('Тестовое вращение — смотри оверлей (страница должна быть открыта)');
  } catch (e) { toast(e.message, true); }
});

$('#wh-export').addEventListener('click', async () => {
  const st = await api('/api/settings');
  const w = st.wheel ?? {};
  const items = whItems.filter((x) => x.label && x.weight > 0);
  const palette = ['#8b5cf6', '#22c55e', '#eab308', '#38bdf8', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];
  const sectors = items.map((it, i) => ({ label: it.label, weight: it.weight, color: it.color || palette[i % palette.length] }));
  const cfg = {
    mode: w.mode ?? 'reward',
    rewardName: w.rewardName ?? 'колесо',
    cooldown: w.cooldown ?? 60,
    items: sectors,
    overlay: { ...whOverlay, duration: Number($('#wh-duration').value) || 8, spinSound: $('#wh-sound').value, winnerTemplate: $('#wh-template').value },
  };
  const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"/>
<title>Шаблон рулетки — ${esc(w.rewardName || 'колесо')}</title>
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:'Segoe UI',sans-serif}
  #stage{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
  #canvas{border-radius:50%}
  .arrow{width:0;height:0;border-left:14px solid transparent;border-right:14px solid transparent;border-top:24px solid #fff;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}
  .winner{font-size:28px;font-weight:700;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.8)}
</style>
</head>
<body>
<div id="stage">
  <canvas id="canvas"></canvas>
  <div class="arrow"></div>
  <div class="winner" id="winner"></div>
</div>
<script>
  // === КОНТРАКТ: бот шлёт SSE-событие {kind:'wheel', user, label, index, sectors, wheelCfg} ===
  // === Кастомизируй что угодно: сектора/цвета/анимацию/звук — это ТВОЙ файл ===
  const CFG = ${JSON.stringify(cfg, null, 2)};
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const winner = document.getElementById('winner');
  let rot = 0, raf = 0;

  function draw() {
    const W = CFG.overlay.size;
    canvas.width = W; canvas.height = W;
    const R = W / 2;
    ctx.clearRect(0, 0, W, W);
    const total = CFG.items.reduce((s, x) => s + x.weight, 0);
    let a = rot;
    for (const s of CFG.items) {
      const span = s.weight / total * Math.PI * 2;
      ctx.beginPath();
      ctx.fillStyle = s.color;
      ctx.moveTo(R, R);
      ctx.arc(R, R, R, a - Math.PI / 2, a - Math.PI / 2 + span);
      ctx.closePath(); ctx.fill();
      if (span > 0.15) {
        const mid = a - Math.PI / 2 + span / 2;
        const r = R * 0.62;
        ctx.save();
        ctx.translate(R + Math.cos(mid) * r, R + Math.sin(mid) * r);
        ctx.rotate(mid + Math.PI / 2);
        ctx.fillStyle = '#fff';
        ctx.font = \`700 \${W * 0.04}px 'Segoe UI',sans-serif\`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(s.label.slice(0, 22), 0, 0);
        ctx.restore();
      }
      a += span;
    }
    ctx.beginPath(); ctx.arc(R, R, R * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12,10,25,.9)'; ctx.fill();
  }

  function spin(ev) {
    const sectors = ev.sectors || CFG.items;
    const target = ev.index ?? 0;
    const total = sectors.reduce((s, x) => s + (x.weight || 1), 0);
    let acc = 0;
    for (let i = 0; i < target; i++) acc += (sectors[i].weight || 1) / total;
    const centerFrac = acc + (sectors[target].weight || 1) / total / 2;
    const targetAngle = (1 - centerFrac) * Math.PI * 2;
    const final = Math.PI * 2 * 6 + targetAngle;
    const t0 = performance.now(), DUR = 5200;
    cancelAnimationFrame(raf);
    winner.textContent = '';
    const frame = (t) => {
      const p = Math.min(1, (t - t0) / DUR);
      const ease = 1 - Math.pow(1 - p, 3);
      rot = final * ease;
      draw();
      if (p < 1) { raf = requestAnimationFrame(frame); }
      else {
        winner.textContent = (CFG.overlay.winnerTemplate || '🏆 {user} → {label}')
          .replaceAll('{user}', ev.user || '')
          .replaceAll('{label}', ev.label || sectors[target].label || '');
        setTimeout(() => { winner.textContent = ''; }, (CFG.overlay.duration || 8) * 1000);
      }
    };
    raf = requestAnimationFrame(frame);
  }

  // слушаем ту же SSE-шину, что и оверлей бота
  const es = new EventSource('/overlay/feed');
  es.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data);
      if (ev.kind === 'wheel' && Array.isArray(ev.sectors)) spin(ev);
    } catch {}
  };

  draw();
</script>
</body>
</html>`;

  // скачиваем HTML-шаблон + JSON
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'roulette-template.html';
  a.click();
  URL.revokeObjectURL(url);
  toast('Шаблон рулетки скачан — правь под себя, файл принимает SSE-события бота');
});

// ⬇ OWE-экспорт: файл в формате Overlay Widget Editor (плейсхолдеры {Size}, {OutcomeNames} и т.д.)
$('#wh-export-owe').addEventListener('click', async () => {
  const items = whItems.filter((x) => x.label && x.weight > 0);
  if (!items.length) { toast('Сначала добавь варианты', true); return; }
  const palette = ['#8b5cf6', '#22c55e', '#eab308', '#38bdf8', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];
  const names = items.map((x) => `"${x.label}"`).join(', ');
  const colors = items.map((x, i) => `"${x.color || palette[i % palette.length]}"`).join(', ');
  const probs = items.map((x) => x.weight).join(', ');
  const total = items.reduce((s, x) => s + x.weight, 0);
  const normalized = items.map((x) => (x.weight / total).toFixed(6)).join(', ');

  const oweHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
.maindiv {
  position: absolute;
  width: 100%;
  max-width: 100%;
  min-width: 100%;
  height: 100%;
  max-height: 100%;
  min-height: 100%;
  margin: 0px;
  z-index: {Layer};
}
.contentdiv {
  position: absolute;
  margin: 0px;
  left: {XPosition}{PositionTypeUnit};
  top: {YPosition}{PositionTypeUnit};
  transform: translate({XTranslation}%, {YTranslation}%);
  width: {Width};
  height: {Height};
}
.text {
  font-size: {FontSize}px;
  color: {FontColor};
  font-family: '{FontFamily}';
  font-weight: {FontWeight};
  text-decoration: {TextDecoration};
  font-style: {FontStyle};
  text-align: {TextAlignment};
  text-shadow: {ShadowColor};
}
</style>
</head>
<body>
<div id="maindiv" class="maindiv">
<div id="contentdiv" class="contentdiv">
<div style="display: flex">
  <div>
    <canvas id="wheelCanvas" width="{Size}" height="{Size}" />
  </div>
  <div>
    <canvas id="arrowCanvas" width="50" height="{Size}" />
  </div>
</div>
</div>
</div>
<script>
const main = document.getElementById("maindiv");
const wheelCanvas = document.getElementById("wheelCanvas");
const arrowCanvas = document.getElementById("arrowCanvas");
hideWheel();
const startingSpeed = 10;
const spinsPerSpeed = 100;
const totalIntervals = 15;
const intervalDivider = 1.5;
const soundInterval = 75;
const xPosition = {Size} / 2;
const yPosition = {Size} / 2;
const radius = {Size} / 2;
const names = [{OutcomeNames}];
const colors = [{OutcomeColors}];
const wheelClickSoundURL = "{WheelClickSoundURL}";
var probabilities = [{OutcomeProbability}];
drawArrow(arrowCanvas.getContext("2d"), yPosition + radius);
function showWheel(data) {
  drawWheel(wheelCanvas.getContext("2d"), xPosition, yPosition, radius, probabilities, names, colors);
  main.style.visibility = 'visible';
}
function startSpin(data) {
  probabilities = data.ModifiedProbabilities;
  showWheel(data);
  var modifiedRotation = (1.0 - data.WinningProbability) * 360;
  var trackingSpeed = startingSpeed;
  for (var i = 0; i < totalIntervals; i++) {
    modifiedRotation -= trackingSpeed * spinsPerSpeed;
    trackingSpeed = trackingSpeed / intervalDivider;
  }
  modifiedRotation = modifiedRotation % 360;
  initialSpin(startingSpeed, 0, 0, 0, modifiedRotation);
}
function initialSpin(speed, spins, rotation, soundRotation, modifiedRotation) {
  setTimeout(() => {
    rotation += speed;
    if (rotation >= 360) rotation -= 360;
    wheelCanvas.style.transform = "rotate(" + rotation + "deg)";
    soundRotation = playWheelClickSound(soundRotation, speed);
    spins++;
    if (spins >= spinsPerSpeed) {
      spins = 0;
      slowdownSpin(speed, spins, modifiedRotation, 0, soundRotation);
    } else {
      initialSpin(speed, spins, rotation, soundRotation, modifiedRotation);
    }
  }, 5);
}
function slowdownSpin(speed, spins, rotation, intervals, soundRotation) {
  setTimeout(() => {
    rotation += speed;
    if (rotation >= 360) rotation -= 360;
    wheelCanvas.style.transform = "rotate(" + rotation + "deg)";
    soundRotation = playWheelClickSound(soundRotation, speed);
    spins++;
    if (spins >= spinsPerSpeed) {
      speed = speed / intervalDivider;
      intervals++;
      spins = 0;
    }
    if (intervals < totalIntervals) {
      slowdownSpin(speed, spins, rotation, intervals, soundRotation);
    } else {
      sendParentMessage({ Type: "WheelLanded", ID: "{ID}" });
      setTimeout(() => { hideWheel(); }, 2000);
    }
  }, 5);
}
function hideWheel() {
  main.style.visibility = 'hidden';
}
function playWheelClickSound(soundRotation, speed) {
  soundRotation += speed;
  if (soundRotation >= soundInterval) {
    soundRotation = 0;
    var audio = new Audio(wheelClickSoundURL);
    audio.volume = {WheelClickVolume};
    audio.play();
  }
  return soundRotation;
}
function drawWheel(context, x, y, radius, probabilities, names, colors) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  var startingAngle = 0;
  for (let i = 0; i < probabilities.length; i++) {
    var endingAngle = startingAngle + (Math.PI * probabilities[i] * 2);
    drawOutcome(context, x, y, radius, startingAngle, endingAngle, colors[i]);
    drawName(context, x, y, radius, startingAngle, endingAngle, names[i]);
    startingAngle = endingAngle;
  }
}
function drawOutcome(context, x, y, radius, startAngle, endAngle, color) {
  context.beginPath();
  context.fillStyle = color;
  context.moveTo(x, y);
  context.arc(x, y, radius, startAngle, endAngle);
  context.fill();
  context.stroke();
}
function drawName(context, x, y, radius, startingAngle, endingAngle, text) {
  const halfRadius = (3 * radius / 5);
  const rotation = ((endingAngle - startingAngle) / 2) + startingAngle;
  context.save();
  context.translate(x + (halfRadius * Math.cos(rotation)), y + (halfRadius * Math.sin(rotation)));
  context.rotate(rotation);
  context.fillStyle = "{FontColor}";
  context.font = "{FontSize}px {FontFamily}";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 0, 0);
  context.restore();
}
function drawArrow(context, height) {
  var startingY = height / 2;
  context.beginPath();
  context.fillStyle = "black";
  context.moveTo(0, startingY);
  context.lineTo(50, startingY - 25);
  context.lineTo(50, startingY + 25);
  context.lineTo(0, startingY);
  context.fill();
  context.stroke();
}
sendParentMessage({ Type: "WidgetLoaded", ID: "{ID}" });
</script>
</body>
</html>`;

  // заполняем OWE-плейсхолдеры реальными значениями
  const filled = oweHtml
    .replaceAll('{Size}', String(whOverlay.size))
    .replaceAll('{Layer}', '45')
    .replaceAll('{XPosition}', String(Math.round(whOverlay.x - whOverlay.size / 2)))
    .replaceAll('{YPosition}', String(Math.round(whOverlay.y - whOverlay.size / 2)))
    .replaceAll('{PositionTypeUnit}', 'px')
    .replaceAll('{XTranslation}', '0')
    .replaceAll('{YTranslation}', '0')
    .replaceAll('{Width}', '100%')
    .replaceAll('{Height}', '100%')
    .replaceAll('{FontSize}', String(Math.round(whOverlay.size * 0.04)))
    .replaceAll('{FontColor}', '#ffffff')
    .replaceAll('{FontFamily}', 'Segoe UI')
    .replaceAll('{FontWeight}', '700')
    .replaceAll('{TextDecoration}', 'none')
    .replaceAll('{FontStyle}', 'normal')
    .replaceAll('{TextAlignment}', 'center')
    .replaceAll('{ShadowColor}', '0 2px 8px rgba(0,0,0,.8)')
    .replaceAll('{OutcomeNames}', names)
    .replaceAll('{OutcomeColors}', colors)
    .replaceAll('{OutcomeProbability}', normalized)
    .replaceAll('{WheelClickSoundURL}', whOverlay.spinSound ? `/media/${whOverlay.spinSound}` : '')
    .replaceAll('{WheelClickVolume}', '0.5')
    .replaceAll('{ID}', Date.now().toString())
    .replaceAll('{IsLivePreview}', 'false')
    .replaceAll('{EntranceAnimationFramework}', 'none')
    .replaceAll('{EntranceAnimationName}', 'none')
    .replaceAll('{OutcomeSelectedAnimationFramework}', 'none')
    .replaceAll('{OutcomeSelectedAnimationName}', 'none')
    .replaceAll('{ExitAnimationFramework}', 'none')
    .replaceAll('{ExitAnimationName}', 'none');

  const url = URL.createObjectURL(new Blob([filled], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'roulette-owe-template.html';
  a.click();
  URL.revokeObjectURL(url);
  toast('OWE-шаблон скачан — совместим с Overlay Widget Editor');
});

// ---------- ⏱ таймер донатона: панель ----------

// ссылка встраивания: отдельная страница «только таймер» (без алертов) — для OBS-сцены
$('#dt-embed-url').value = `${location.origin}/dtimer`;
$('#dt-embed-open').href = `${location.origin}/dtimer`;
$('#dt-embed-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#dt-embed-url').value); toast('Скопировано ✅'); }
  catch { $('#dt-embed-url').select(); toast('Выделила поле — Ctrl+C', true); }
});
// читается из /api/state (donaTimer: {enabled, running, secondsLeft, totalRub, label, footer, accent})

function dtRender(st) {
  const dt = st.donaTimer ?? {};
  const cfg = window.__settings?.donaTimer ?? {};
  $('#dt-enabled').checked = dt.enabled === true;
  const baseTotal = (Number(cfg.baseMinutes) || 0) * 60 + (Number(cfg.baseSeconds) || 0);
  if (document.activeElement?.id !== 'dt-base-h') $('#dt-base-h').value = Math.floor(baseTotal / 3600);
  if (document.activeElement?.id !== 'dt-base-m') $('#dt-base-m').value = Math.floor((baseTotal % 3600) / 60);
  if (document.activeElement?.id !== 'dt-base-s') $('#dt-base-s').value = baseTotal % 60;
  if (document.activeElement?.id !== 'dt-price') $('#dt-price').value = cfg.pricePerMinute ?? 30;
  if (document.activeElement?.id !== 'dt-label') $('#dt-label').value = cfg.label ?? 'стрим закончится через';
  if (document.activeElement?.id !== 'dt-footer') $('#dt-footer').value = cfg.footer ?? 'продлить стрим: 30₽ за минуту';
  if (document.activeElement?.id !== 'dt-accent') $('#dt-accent').value = cfg.accent ?? '#ff5a4d';
  // источники: токены и webhook-секреты (password-поля не перезаписываем, пока юзер печатает)
  const don = window.__settings?.donations ?? {};
  if (document.activeElement?.id !== 'dt-donatex-token') $('#dt-donatex-token').value = don.donatex?.token ?? '';
  if (document.activeElement?.id !== 'dt-donatex-wh') $('#dt-donatex-wh').value = don.donatex?.webhookSecret ?? '';
  if (document.activeElement?.id !== 'dt-da-token') $('#dt-da-token').value = don.da?.token ?? '';
  if (document.activeElement?.id !== 'dt-da-wh') $('#dt-da-wh').value = don.da?.webhookSecret ?? '';
  if (document.activeElement?.id !== 'dt-dpay-token') $('#dt-dpay-token').value = don.donatepay?.token ?? '';
  if (document.activeElement?.id !== 'dt-dpay-wh') $('#dt-dpay-wh').value = don.donatepay?.webhookSecret ?? '';
  const h = Math.floor((dt.secondsLeft ?? 0) / 3600);
  const m = Math.floor(((dt.secondsLeft ?? 0) % 3600) / 60);
  const s = (dt.secondsLeft ?? 0) % 60;
  // поля «сейчас»: живой актуальный остаток; не перезаписываем то, что юзер печатает
  if (document.activeElement?.id !== 'dt-set-h') $('#dt-set-h').value = h;
  if (document.activeElement?.id !== 'dt-set-m') $('#dt-set-m').value = m;
  if (document.activeElement?.id !== 'dt-set-s') $('#dt-set-s').value = s;
  $('#dt-status').textContent = dt.enabled
    ? `${dt.running ? '▶ тикает' : '⏸ пауза'} · ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} · собрано ${dt.totalRub ?? 0}₽`
    : 'выключен';
}

// сохранение настроек
$('#dt-save').addEventListener('click', async () => {
  try {
    await putSettings({
      donaTimer: {
        enabled: $('#dt-enabled').checked,
        baseMinutes: Math.max(0, Number($('#dt-base-h').value) || 0) * 60 + Math.max(0, Number($('#dt-base-m').value) || 0),
        baseSeconds: Math.max(0, Number($('#dt-base-s').value) || 0),
        pricePerMinute: Number($('#dt-price').value) || 30,
        label: $('#dt-label').value.trim(),
        footer: $('#dt-footer').value.trim(),
        accent: $('#dt-accent').value,
      },
    });
    toast('Таймер донатона сохранён ⏱');
    poll();
  } catch (e) { toast(e.message, true); }
});
$('#dt-enabled').addEventListener('change', async () => {
  try {
    await putSettings({ donaTimer: { enabled: $('#dt-enabled').checked } });
    toast($('#dt-enabled').checked ? 'Таймер включён ⏱' : 'Таймер выключен');
  } catch (e) { toast(e.message, true); }
});

// источники
$('#dt-src-save').addEventListener('click', async () => {
  try {
    await putSettings({
      donations: {
        donatex: { enabled: $('#dt-donatex-on').checked, token: $('#dt-donatex-token').value.trim(), webhookSecret: $('#dt-donatex-wh').value.trim() },
        da: { enabled: $('#dt-da-on').checked, token: $('#dt-da-token').value.trim(), webhookSecret: $('#dt-da-wh').value.trim() },
        donatepay: { enabled: $('#dt-dpay-on').checked, token: $('#dt-dpay-token').value.trim(), webhookSecret: $('#dt-dpay-wh').value.trim() },
      },
    });
    toast('Источники донатов сохранены 💰');
  } catch (e) { toast(e.message, true); }
});

// вручную: ±минуты и донат
$('#dt-set-btn').addEventListener('click', async () => {
  const sec = (Math.max(0, Number($('#dt-set-h').value) || 0)) * 3600
    + (Math.max(0, Number($('#dt-set-m').value) || 0)) * 60
    + Math.max(0, Number($('#dt-set-s').value) || 0);
  try {
    const r = await api('/api/actions/donatimerset', { method: 'POST', body: JSON.stringify({ sec }) });
    if (r.error) { toast(r.error, true); return; }
    toast(sec > 0 ? `Установлено: ${$('#dt-set-h').value || 0}ч ${$('#dt-set-m').value || 0}м ${$('#dt-set-s').value || 0}с ⏱` : 'Таймер на нуле ⏱');
    poll();
  } catch (e) { toast(e.message, true); }
});
$('#dt-add-btn').addEventListener('click', async () => {
  const min = Number($('#dt-add-min').value) || 0;
  if (!min) { toast('Введи минуты (можно с минусом)', true); return; }
  try {
    const r = await api('/api/actions/donatimeradd', { method: 'POST', body: JSON.stringify({ min }) });
    if (r.error) { toast(r.error, true); return; }
    toast(min > 0 ? `+${min} мин ⏱` : `${min} мин ⏱`);
    poll();
  } catch (e) { toast(e.message, true); }
});
$('#dt-donate-btn').addEventListener('click', async () => {
  const amount = Number($('#dt-donate-amount').value) || 0;
  if (!amount) { toast('Введи сумму ₽', true); return; }
  try {
    const r = await api('/api/actions/donatimerdonation', { method: 'POST', body: JSON.stringify({ amount }) });
    if (r.error) { toast(r.error, true); return; }
    toast(`Донат ${amount}₽ внесён 💰`);
    poll();
  } catch (e) { toast(e.message, true); }
});

// ---------- 💬 чат-виджет: панель (Оверлеи → Чат-виджет; страница /chat) ----------
$('#cw-embed-url').value = `${location.origin}/chat`;
$('#cw-embed-open').href = `${location.origin}/chat`;
$('#cw-embed-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#cw-embed-url').value); toast('Скопировано ✅'); }
  catch { $('#cw-embed-url').select(); toast('Выделила поле — Ctrl+C', true); }
});

// те же SVG-декорации, что на странице /chat (без внешних картинок)
const CW_SVG_GEM = (fill) => `<svg class="cw-p-gem" viewBox="0 0 32 32"><path fill="${fill}" d="M28.9 19.7 19.7 28.9a6.2 6.2 0 0 1-8.8 0L2.6 19.7a6.2 6.2 0 0 1 0-8.8l8.3-8.6a6.2 6.2 0 0 1 8.8 0l9.2 8.6a6.2 6.2 0 0 1 0 8.8Z" opacity=".85"/></svg>`;
const CW_SVG_STAR = `<svg class="cw-p-star" viewBox="0 0 24 24"><path fill="#fff" d="M12 1.6 14.9 8l7 .6-5.3 4.6 1.6 6.8L12 16.5l-6.2 3.5 1.6-6.8L2.1 8.6l7-.6Z"/></svg>`;
const CW_SVG_WEB = `<svg class="cw-p-web" viewBox="0 0 60 60" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.4"><path d="M0 0 L60 60 M0 0 L38 8 M0 0 L8 38 M0 0 L60 22 M0 0 L22 60 M0 0 L60 0 M0 0 L0 60"/><path d="M12 0 Q16 12 0 16 M24 0 Q30 24 0 30 M40 0 Q48 40 0 48" opacity=".8"/></svg>`;
const CW_SVG_GHOST = `<svg class="cw-p-ghost" viewBox="0 0 40 46"><path fill="#f0f3ff" stroke="#a6a9d3" stroke-width="2" d="M20 3c-8 0-14 6-14 14v20c0 2 2 3 3.6 1.6l3-3.2 3 3.4c1 1.2 2.8 1.2 3.8 0l3-3.4 3 3.4c1 1.2 2.8 1.2 3.8 0l3-3.4 3 3.2C31.9 40 34 39 34 37V17c0-8-6-14-14-14Z"/><ellipse cx="14" cy="19" rx="2.6" ry="3.6" fill="#141520"/><ellipse cx="26" cy="19" rx="2.6" ry="3.6" fill="#141520"/><path d="M16 27q4 3 8 0" stroke="#141520" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;

// текущие значения полей → объект настроек (для превью и сохранения)
function cwCurrent() {
  return {
    enabled: $('#cw-enabled').checked,
    limit: Math.max(1, Math.min(50, Number($('#cw-limit').value) || 15)),
    hideAfter: Math.max(3, Math.min(3600, Number($('#cw-hideafter').value) || 999)),
    hideCommands: $('#cw-hidecommands').checked,
    roleColors: $('#cw-rolecolors').checked,
    showPronouns: $('#cw-pronouns').checked,
    ignoredUsers: $('#cw-ignored').value.trim(),
    theme: {
      name: $('#cw-name').value.trim() || 'чистая',
      x: Math.max(0, Math.min(1600, Number($('#cw-x').value) || 40)),
      y: Math.max(0, Math.min(1000, Number($('#cw-y').value) || 40)),
      maxWidth: Math.max(20, Math.min(100, Number($('#cw-maxw').value) || 80)),
      gap: Math.max(0, Math.min(120, Number($('#cw-gap').value) || 24)),
      scale: Math.max(25, Math.min(300, Number($('#cw-scale').value) || 100)),
      fontFamily: $('#cw-font').value,
      fontSize: Math.max(10, Math.min(60, Number($('#cw-fontsize').value) || 16)),
      chipBg: $('#cw-chipbg').value,
      chipColor: $('#cw-chiptext').value,
      chipRadius: Math.max(0, Math.min(60, Number($('#cw-chipradius').value) || 0)),
      chipCase: $('#cw-case').checked,
      gem: $('#cw-gem').checked,
      msgBg: $('#cw-msgbg').value,
      msgColor: $('#cw-msgcolor').value,
      msgBorder: $('#cw-msgborder').value,
      msgBorderWidth: Math.max(0, Math.min(12, Number($('#cw-msgbw').value) || 0)),
      msgRadius: Math.max(0, Math.min(60, Number($('#cw-msgradius').value) || 0)),
      msgPaper: $('#cw-paper').checked,
      colorBroadcaster: $('#cw-cbroad').value,
      colorModerator: $('#cw-cmod').value,
      colorVip: $('#cw-cvip').value,
      ghost: $('#cw-ghost').checked,
      webs: $('#cw-webs').checked,
      subStar: $('#cw-substar').checked,
      animIn: $('#cw-anim').value,
    },
  };
}

// живое превью: три мок-сообщения в стиле страницы /chat
function cwPreview() {
  const c = cwCurrent();
  const t = c.theme;
  const box = $('#cw-preview');
  const colors = { broadcaster: t.colorBroadcaster, moderator: t.colorModerator, vip: t.colorVip, sub: t.chipBg, all: t.chipBg };
  const mock = [
    { role: 'broadcaster', sub: true, user: 'Стримерка', text: 'всем привет на стриме!' },
    { role: 'all', sub: false, user: 'зритель', text: 'классный стрим, огонь 🔥' },
    { role: 'vip', sub: true, user: 'Випушка', text: 'лови лучи добра ✨' },
  ];
  box.innerHTML = `<div class="cw-p-wrap" style="transform:scale(${(t.scale / 100).toFixed(2)});font-family:${esc(t.fontFamily || `'Segoe UI', Arial, sans-serif`)}"></div>`;
  const wrap = box.firstChild;
  for (const m of mock) {
    const chipColor = c.roleColors ? colors[m.role] : t.chipBg;
    const row = document.createElement('div');
    row.className = 'cw-p-row';
    row.innerHTML = `
      <div class="cw-p-name">${t.gem ? CW_SVG_GEM(chipColor) : ''}
        <div class="cw-p-chip" style="background:${chipColor};color:${t.chipColor};border-radius:${t.chipRadius}px;text-transform:${t.chipCase ? 'uppercase' : 'none'};font-size:${t.fontSize}px">${esc(m.user)}${m.sub && t.subStar ? CW_SVG_STAR : ''}</div>
        ${m.sub && t.ghost ? CW_SVG_GHOST : ''}
      </div>
      <div class="cw-p-msg" style="background:${t.msgBg};border:${t.msgBorderWidth}px solid ${t.msgBorder};border-radius:${t.msgRadius}px;color:${t.msgColor};font-size:${t.fontSize}px;${t.msgPaper ? '' : '--cw-p-paper:none;'}">
        ${t.webs ? CW_SVG_WEB : ''}<p style="display:inline">…</p>
      </div>`;
    row.querySelector('.cw-p-msg p').textContent = m.text; // текст — только textContent
    if (!t.msgPaper) row.querySelector('.cw-p-msg').classList.add('cw-p-nopaper');
    wrap.appendChild(row);
  }
}

// загрузка настроек в поля (при старте панели)
async function cwLoad() {
  try {
    const st = await api('/api/settings');
    const c = st.chatWidget ?? {};
    const t = c.theme ?? {};
    $('#cw-enabled').checked = c.enabled === true;
    $('#cw-limit').value = c.limit ?? 15;
    $('#cw-hideafter').value = c.hideAfter ?? 999;
    $('#cw-hidecommands').checked = c.hideCommands !== false;
    $('#cw-rolecolors').checked = c.roleColors !== false;
    $('#cw-pronouns').checked = c.showPronouns === true;
    $('#cw-ignored').value = c.ignoredUsers ?? '';
    $('#cw-name').value = t.name ?? 'чистая';
    $('#cw-x').value = t.x ?? 40;
    $('#cw-y').value = t.y ?? 40;
    $('#cw-maxw').value = t.maxWidth ?? 80;
    $('#cw-gap').value = t.gap ?? 24;
    $('#cw-scale').value = t.scale ?? 100;
    $('#cw-fontsize').value = t.fontSize ?? 16;
    $('#cw-font').innerHTML = fontOptions(t.fontFamily ?? '');
    $('#cw-chipbg').value = t.chipBg ?? '#a6a9d3';
    $('#cw-chiptext').value = t.chipColor ?? '#f0e7e5';
    $('#cw-chipradius').value = t.chipRadius ?? 20;
    $('#cw-case').checked = t.chipCase !== false;
    $('#cw-gem').checked = t.gem === true;
    $('#cw-msgbg').value = t.msgBg ?? '#141520';
    $('#cw-msgcolor').value = t.msgColor ?? '#a6a9d3';
    $('#cw-msgborder').value = t.msgBorder ?? '#6a6d98';
    $('#cw-msgbw').value = t.msgBorderWidth ?? 2;
    $('#cw-msgradius').value = t.msgRadius ?? 15;
    $('#cw-paper').checked = t.msgPaper === true;
    $('#cw-cbroad').value = t.colorBroadcaster ?? '#f1592a';
    $('#cw-cmod').value = t.colorModerator ?? '#edb872';
    $('#cw-cvip').value = t.colorVip ?? '#a672ed';
    $('#cw-ghost').checked = t.ghost === true;
    $('#cw-webs').checked = t.webs === true;
    $('#cw-substar').checked = t.subStar !== false;
    $('#cw-anim').value = ['scale', 'slide', 'fade'].includes(t.animIn) ? t.animIn : 'scale';
    cwPreview();
  } catch (e) { toast(e.message, true); }
}
cwLoad().catch(() => {});

// любое поле меняется → превью перерисовывается мгновенно
const CW_FIELDS = ['#cw-enabled', '#cw-limit', '#cw-hideafter', '#cw-hidecommands', '#cw-rolecolors', '#cw-pronouns', '#cw-ignored',
  '#cw-name', '#cw-x', '#cw-y', '#cw-maxw', '#cw-gap', '#cw-scale', '#cw-fontsize', '#cw-font',
  '#cw-chipbg', '#cw-chiptext', '#cw-chipradius', '#cw-case', '#cw-gem',
  '#cw-msgbg', '#cw-msgcolor', '#cw-msgborder', '#cw-msgbw', '#cw-msgradius', '#cw-paper',
  '#cw-cbroad', '#cw-cmod', '#cw-cvip', '#cw-ghost', '#cw-webs', '#cw-substar', '#cw-anim'];
for (const id of CW_FIELDS) {
  $(id)?.addEventListener('input', cwPreview);
  $(id)?.addEventListener('change', cwPreview);
}

// галка «виджет включён» сохраняется сразу (как у таймера) — не надо жать «Сохранить»
$('#cw-enabled').addEventListener('change', async () => {
  try {
    await putSettings({ chatWidget: { enabled: $('#cw-enabled').checked } });
    toast($('#cw-enabled').checked ? 'Чат-виджет включён 💬' : 'Чат-виджет выключен');
  } catch (e) { toast(e.message, true); }
});

$('#cw-save').addEventListener('click', async () => {
  try {
    await putSettings({ chatWidget: cwCurrent() });
    toast('Чат-виджет сохранён 💬');
  } catch (e) { toast(e.message, true); }
});

// экспорт темы: файл в формате docs/CHAT-THEME-SPEC.md (обратно импортируется)
$('#cw-export').addEventListener('click', () => {
  const data = { format: 'twitch-bot-chat-theme', version: 1, theme: cwCurrent().theme };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chat-theme-${(data.theme.name || 'theme').replace(/[^\w\-а-яё]+/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Тема скачана — файл совместим с импортом ⬇');
});

// импорт темы: файл → поля конструктора (Сохранить — отдельно, как обычно)
$('#cw-import-btn').addEventListener('click', () => $('#cw-import-file').click());
$('#cw-import-file').addEventListener('change', async () => {
  const file = $('#cw-import-file')?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const j = JSON.parse(text);
    const theme = (j && j.theme && typeof j.theme === 'object') ? j.theme : j;
    if (!theme || typeof theme !== 'object') throw new Error('в файле нет темы');
    const t = { ...theme }; // сервер дорежет по лимитам при сохранении (normalizeTheme)
    $('#cw-name').value = String(t.name ?? 'импортированная').slice(0, 40);
    $('#cw-x').value = Number(t.x) || 40;
    $('#cw-y').value = Number(t.y) || 40;
    $('#cw-maxw').value = Number(t.maxWidth) || 80;
    $('#cw-gap').value = Number(t.gap) ?? 24;
    $('#cw-scale').value = Number(t.scale) || 100;
    $('#cw-fontsize').value = Number(t.fontSize) || 16;
    $('#cw-font').innerHTML = fontOptions(String(t.fontFamily ?? ''));
    if (t.chipBg) $('#cw-chipbg').value = t.chipBg;
    if (t.chipColor) $('#cw-chiptext').value = t.chipColor;
    $('#cw-chipradius').value = Number(t.chipRadius) ?? 20;
    $('#cw-case').checked = t.chipCase !== false;
    $('#cw-gem').checked = t.gem === true;
    if (t.msgBg) $('#cw-msgbg').value = t.msgBg;
    if (t.msgColor) $('#cw-msgcolor').value = t.msgColor;
    if (t.msgBorder) $('#cw-msgborder').value = t.msgBorder;
    $('#cw-msgbw').value = Number(t.msgBorderWidth) ?? 2;
    $('#cw-msgradius').value = Number(t.msgRadius) ?? 15;
    $('#cw-paper').checked = t.msgPaper === true;
    if (t.colorBroadcaster) $('#cw-cbroad').value = t.colorBroadcaster;
    if (t.colorModerator) $('#cw-cmod').value = t.colorModerator;
    if (t.colorVip) $('#cw-cvip').value = t.colorVip;
    $('#cw-ghost').checked = t.ghost === true;
    $('#cw-webs').checked = t.webs === true;
    $('#cw-substar').checked = t.subStar !== false;
    if (['scale', 'slide', 'fade'].includes(t.animIn)) $('#cw-anim').value = t.animIn;
    cwPreview();
    toast('Тема загружена в конструктор — жми «💾 Сохранить»');
  } catch (e) { toast(`Не получилось прочитать тему: ${e.message}`, true); }
  $('#cw-import-file').value = '';
});

// тест-сообщения: уезжают на открытую страницу /chat
async function cwTest(role) {
  try {
    const r = await api('/api/actions/chattest', {
      method: 'POST',
      body: JSON.stringify({ role, user: $('#cw-test-user').value.trim() || 'Тест', text: $('#cw-test-text').value.trim() }),
    });
    if (r.error) { toast(r.error, true); return; }
    toast('Тестовое сообщение отправлено — открой страницу /chat 📺');
  } catch (e) { toast(e.message, true); }
}
$('#cw-test-all').addEventListener('click', () => cwTest('all'));
$('#cw-test-sub').addEventListener('click', () => cwTest('sub'));
$('#cw-test-vip').addEventListener('click', () => cwTest('vip'));
$('#cw-test-mod').addEventListener('click', () => cwTest('mod'));
$('#cw-test-broad').addEventListener('click', () => cwTest('broadcaster'));

// перерисовка при разворачивании секции (stage был нулевой ширины пока свёрнут)
(() => {
  const det = document.querySelector('details summary')?.closest('details');
  // все details с wh-stage/wod-stage/plp-stage/aso-stage внутри — слушаем toggle
  for (const d of document.querySelectorAll('details')) {
    d.addEventListener('toggle', () => {
      if (d.open) {
        requestAnimationFrame(() => {
          if ($('#wh-stage') && d.contains($('#wh-stage'))) whEdLoad(whOverlay);
          if ($('#wod-stage') && d.contains($('#wod-stage'))) { wodRenderStage(); wodRenderProps(); }
          if ($('#plp-stage') && d.contains($('#plp-stage'))) { plpRenderStage(); plpRenderProps(); }
          if ($('#aso-stage') && d.contains($('#aso-stage'))) { asoRenderStage(); asoRenderProps(); }
        });
      }
    });
  }
})();

// ⬆ Импорт .miuoverlay (MixItUp) или JSON — кнопка или перетащить файл
const COLOR_NAMES = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  brown: '#a52a2a', lightcoral: '#f08080', lightblue: '#add8e6', lightgreen: '#90ee90',
  lightyellow: '#ffffe0', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9', orange: '#ffa500', yellow: '#ffff00', purple: '#800080',
  pink: '#ffc0cb', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080',
  gold: '#ffd700', silver: '#c0c0c0', crimson: '#dc143c', teal: '#008080', navy: '#000080',
  maroon: '#800000', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff',
  indigo: '#4b0082', violet: '#ee82ee', khaki: '#f0e68c', coral: '#ff7f50',
  salmon: '#fa8072', tomato: '#ff6347', hotpink: '#ff69b4', deeppink: '#ff1493',
  steelblue: '#4682b4', royalblue: '#4169e1', midnightblue: '#191970', forestgreen: '#228b22',
  seagreen: '#2e8b57', darkgreen: '#006400', darkred: '#8b0000', darkblue: '#00008b',
  darkviolet: '#9400d3', darkorange: '#ff8c00', darkcyan: '#008b8b', darkmagenta: '#8b008b',
};

function resolveColor(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('#')) return s;
  return COLOR_NAMES[s] ?? '';
}

function importMiuOverlay(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { error: 'не смогла разобрать файл — это JSON?' }; }
  // MixItUp .miuoverlay: { Item: { Size, Outcomes, FontSize, FontName, FontColor, ... } }
  const item = j.Item ?? j;
  const outcomes = Array.isArray(item.Outcomes) ? item.Outcomes : [];
  if (!outcomes.length) return { error: 'в файле нет вариантов (Outcomes)' };

  const items = outcomes
    .filter((o) => o && String(o.Name || '').trim())
    .map((o) => ({
      label: String(o.Name).trim().slice(0, 60),
      weight: Math.max(1, Math.round(Number(o.Probability) || 10)),
      color: resolveColor(o.Color),
    }))
    .slice(0, 12);

  if (!items.length) return { error: 'все варианты пустые' };

  const size = Math.max(100, Math.min(800, Math.round(Number(item.Size) || 400)));
  const fontSize = Math.max(10, Math.min(60, Math.round(Number(item.FontSize) || 22)));
  // звук: путь вида "C:\...\WheelClick.mp3" — берём имя файла
  const soundPath = String(item.WheelClickSoundFilePath || '');
  const soundFile = soundPath ? soundPath.split(/[\\/]/).pop() : '';

  return {
    items,
    size,
    fontSize,
    soundFile,
    equalProb: Boolean(item.EqualProbabilityForOutcomes),
  };
}

/** Импорт OWE (Overlay Widget Editor): HTML-виджет рулетки — вытащить
 *  names/colors/probabilities/размер/звук так же, как их пишет наш экспорт. */
function importOweHtml(text) {
  const raw = String(text || '');
  if (!/<html/i.test(raw)) return { error: 'это не HTML-виджет OWE' };
  const pick = (re) => {
    const m = raw.match(re);
    return m ? m[1] : null;
  };
  // массив строк: names/outcomeNames, colors/outcomeColors; вероятности — probabilities
  const namesArr = pick(/(?:var|const|let)\s+(?:outcome)?names?\s*=\s*\[([^\]]*)\]/i);
  const colorsArr = pick(/(?:var|const|let)\s+(?:outcome)?colors?\s*=\s*\[([^\]]*)\]/i);
  const probsArr = pick(/(?:var|const|let)\s+(?:outcome)?probabilit(?:ies|y)\s*=\s*\[([^\]]*)\]/i);
  if (!namesArr && !probsArr) return { error: 'в файле нет вариантов (names/probabilities)' };
  const splitStr = (s) => (s ? s.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []);
  const splitNum = (s) => (s ? s.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : []);
  const names = splitStr(namesArr);
  const colors = splitStr(colorsArr).map((c) => (/^#/.test(c) ? c : resolveColor(c)));
  const probs = splitNum(probsArr);
  if (!names.length) return { error: 'варианты пустые' };
  const items = names.slice(0, 12).map((label, i) => ({
    label: label.slice(0, 60),
    weight: Math.max(1, Math.round((probs[i] ?? 0) * 100)) || 10,
    color: colors[i] || '',
  }));
  const size = Math.max(100, Math.min(800, Math.round(Number(raw.match(/radius\s*=\s*(\d+)/)?.[1] ? raw.match(/radius\s*=\s*(\d+)/)[1] * 2 : 400))));
  const soundUrl = pick(/(?:var|const|let)\s+wheelClickSoundURL\s*=\s*"([^"]*)"/i) || '';
  const soundFile = soundUrl ? decodeURIComponent(soundUrl.split('/').pop() || '') : '';
  return { items, size, soundFile };
}

async function applyWheelImport(text, fileName) {
  // .miuoverlay/.json (MixItUp) — сначала; HTML-виджет — Overlay Widget Editor
  let r = null;
  if (/\.html?$/i.test(fileName) || /<html/i.test(String(text).slice(0, 200))) r = importOweHtml(text);
  else r = importMiuOverlay(text);
  if (r.error) { toast(`Импорт: ${r.error}`, true); return; }

  whItems = r.items;
  if (r.equalProb) {
    const w = Math.round(100 / r.items.length) || 10;
    for (const it of r.items) it.weight = w;
  }
  whOverlay.size = r.size;
  renderWheelItems();
  whEdLoad(whOverlay);
  if (r.soundFile) {
    await renderWheelSoundSelect(r.soundFile);
  }
  $('#wh-duration').value = whOverlay.duration ?? 8;
  toast(`Импортировано из ${fileName}: ${r.items.length} вариантов, размер ${r.size}px${r.soundFile ? `, звук: ${r.soundFile}` : ''} — не забудь Сохранить`);
}

// кнопка импорта
$('#wh-import-btn').addEventListener('click', () => $('#wh-import-file').click());
$('#wh-import-file').addEventListener('change', async () => {
  const file = $('#wh-import-file')?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await applyWheelImport(text, file.name);
  } catch (e) { toast(`Импорт: ${e.message}`, true); }
  $('#wh-import-file').value = '';
});

// drag&drop на секцию рулетки
(() => {
  const zone = $('#wh-import-btn')?.closest('.guide-body');
  if (!zone) return;
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); zone.style.outline = '2px dashed var(--accent)'; zone.style.outlineOffset = '4px'; });
  zone.addEventListener('dragleave', () => { zone.style.outline = ''; zone.style.outlineOffset = ''; });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.style.outline = ''; zone.style.outlineOffset = '';
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await applyWheelImport(text, file.name);
    } catch (err) { toast(`Импорт: ${err.message}`, true); }
  });
})();

loadWheel().catch(() => {});

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
  // прямые присваивания — тоже нул-гарды: одно отсутствующее поле не роняет вкладку
  const el = (id) => $(id);
  const set = (id, prop, v) => { const e = el(id); if (e) e[prop] = v; };
  set('music-url', 'textContent', `${location.origin}/music`);
  set('music-url-field', 'value', `${location.origin}/music`);
  set('music-open', 'href', `${location.origin}/music`);
  // все поля — под focus-гардами: очередь/чс дергают эту загрузку прямо во время
  // редактирования правил, нельзя затирать то, что юзер печатает прямо сейчас.
  // null-guard: отсутствующее поле (кеш-микс старого HTML) не должно ронять всю вкладку
  const val = (id, v) => { const el = $(id); if (el && document.activeElement?.id !== id) el.value = v; };
  const chk = (id, v) => { const el = $(id); if (el && document.activeElement?.id !== id) el.checked = v; };
  chk('sg-enabled', Boolean(s.enabled));
  // длина — в минутах в панели, в секундах на сервере
  val('sg-maxlen-min', Math.round((s.maxLenSec ?? 600) / 60));
  val('sg-minviews', s.minViews ?? 0);
  val('sg-template', s.nowTemplate ?? '♪ {title} — заказал {by}');
  // правила заказов
  val('sg-mode', s.requestMode ?? 'command');
  val('sg-reward-name', s.rewardName ?? '');
  val('sg-cmdname', s.commandName ?? 'ср');
  chk('sg-refund-reject', s.refundOnReject !== false);
  chk('sg-refund-limit', s.refundOnLimit !== false);
  val('sg-cd', Math.round((s.commandCooldown ?? 0) / 60));
  val('sg-peruser', s.perUser ?? 2);
  val('sg-allowusers', (s.allowUsers ?? []).join(', '));
  document.querySelectorAll('.sg-role').forEach((cb) => { if (document.activeElement !== cb) cb.checked = (s.allow ?? []).includes(cb.value); });
  sgSyncModeRows();
  renderBlacklist(s.blacklist ?? []);
  plpLoad(s.playerCfg, st);
  __sgApplyState(st);
  sgHydrated = true; // форма заполнена с сервера — сейвы разрешены
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

// тумблер «музыка включена» применяется сразу (без «Сохранить»)
$('#sg-enabled').addEventListener('change', async () => {
  try {
    await putSettings({ songs: { enabled: $('#sg-enabled').checked } });
    toast($('#sg-enabled').checked ? 'Музыка включена 🎵' : 'Музыка выключена');
  } catch (e) { toast(e.message, true); }
});

$('#sg-save').addEventListener('click', async () => {
  if (!(await ensureSgHydrated())) { toast('Форма ещё не загрузилась с сервера — секунду', true); return; }
  try {
    await putSongsDiff({
      enabled: $('#sg-enabled').checked,
      maxLenSec: Math.round((Number($('#sg-maxlen-min').value) || 10) * 60),
      minViews: Math.max(0, Number($('#sg-minviews').value) || 0),
      volume: Number($('#sg-volume').value) || 0,
      nowTemplate: $('#sg-template').value,
    });
    toast('Настройки музыки сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

/**
 * Сохранение настроек музыки с диффом: сначала сверяем каждое поле со свежим
 * сервером и отправляем ТОЛЬКО реально изменённое. Убивает «сбросы»: мёртвая
 * гидратация или забытая вторая вкладка панели физически не может откатить
 * чужие поля — их значения совпадают с сервером и в патч не попадают.
 */
let sgHydrated = false; // форма заполнена с сервера (нельзя сейвить пустую форму)
async function ensureSgHydrated() {
  if (sgHydrated) return true;
  try { await loadSongsTab(); return sgHydrated; } catch { return false; }
}
async function putSongsDiff(patch) {
  const fresh = (await api('/api/settings')).songs ?? {};
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const cur = fresh[k];
    const same = Array.isArray(v)
      ? (Array.isArray(cur) && JSON.stringify([...v].sort()) === JSON.stringify([...cur].sort()))
      : cur === v;
    if (!same) out[k] = v;
  }
  if (!Object.keys(out).length) { toast('Изменений нет — ничего не трогаю'); return; }
  await putSettings({ songs: out });
}

// правила заказов: способ, кулдаун, лимиты, доступ
$('#sg-order-save').addEventListener('click', async () => {
  if (!(await ensureSgHydrated())) { toast('Форма ещё не загрузилась с сервера — секунду', true); return; }
  const allow = [...document.querySelectorAll('.sg-role:checked')].map((cb) => cb.value);
  if (allow.includes('everyone')) allow.length = 0; // «все» = пустой список
  const allowUsers = $('#sg-allowusers').value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await putSongsDiff({
      requestMode: $('#sg-mode').value,
      rewardName: $('#sg-reward-name').value.trim(),
      commandName: $('#sg-cmdname').value.trim(),
      refundOnReject: $('#sg-refund-reject').checked,
      refundOnLimit: $('#sg-refund-limit').checked,
      commandCooldown: Math.round((Number($('#sg-cd').value) || 0) * 60),
      perUser: Math.max(1, Number($('#sg-peruser').value) || 2),
      allow,
      allowUsers,
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
          fontFamily: String(o.fontFamily || '').slice(0, 80),
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
    if (o.borderWidth) div.style.border = `${o.borderWidth * k}px solid ${o.borderColor || '#8b5cf6'}`;
    if (o.type === 'video') {
      div.style.borderRadius = `${Math.max(6, Math.round(o.w * 0.055)) * k}px`;
      const cur = window.__songsState?.current;
      div.style.backgroundImage = cur?.id ? `url(https://i.ytimg.com/vi/${cur.id}/hqdefault.jpg)` : '';
    } else if (o.type === 'marquee') {
      div.style.color = o.color || '#ffffff';
      div.style.fontSize = `${o.fontSize * k}px`;
      if (o.fontFamily) div.style.fontFamily = o.fontFamily;
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
    ${row('прозрачность', `<input type="range" id="plp-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="plp-op-val">${o.opacity}%</span>`)}
    ${row('грань (обводка)', `<span class="hint">цвет</span><input type="color" id="plp-b2color" value="${esc(o.borderColor || '#8b5cf6')}" /><span class="hint">толщ</span><input type="range" id="plp-bw" min="0" max="12" value="${o.borderWidth ?? 0}" style="width:90px" /><span class="hint" id="plp-bw-val">${o.borderWidth ?? 0}px</span>`)}
    <div class="rp-row">
      <label class="hint">размер — ручкой ↘ в превью · слой: сверху 🡒</label>
      <button class="act ghost" id="plp-zup" title="поднять слой">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="plp-zdown" title="опустить слой">▼</button>
      <label class="hint"><input type="checkbox" id="plp-idle" ${o.hideOnIdle ? 'checked' : ''} /> прятать, когда ничего не играет</label>
    </div>`;
  if (o.type === 'marquee') {
    html += row('строка', `<span class="hint">цвет</span><input type="color" id="plp-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="plp-fs" min="10" max="60" value="${o.fontSize}" style="width:56px" /><span class="hint">круг, сек</span><input type="number" id="plp-speed" min="5" max="300" value="${o.speed}" style="width:56px" />`);
    html += row('семейство шрифта', `<select id="plp-font" style="max-width:260px">${fontOptions(o.fontFamily)}</select>`);
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
  $('#plp-font')?.addEventListener('change', () => { o.fontFamily = $('#plp-font').value; plpRenderStage(); });
  $('#plp-speed')?.addEventListener('input', () => { o.speed = Number($('#plp-speed').value) || 30; plpRenderStage(); });
  $('#plp-radius')?.addEventListener('input', () => { o.radius = Number($('#plp-radius').value) || 0; plpRenderStage(); });
  $('#plp-b2color')?.addEventListener('input', () => { o.borderColor = $('#plp-b2color').value; plpRenderStage(); });
  $('#plp-bw')?.addEventListener('input', () => {
    o.borderWidth = Number($('#plp-bw').value) || 0;
    $('#plp-bw-val').textContent = `${o.borderWidth}px`;
    plpRenderStage();
  });
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
      fontFamily: String(o.fontFamily || '').slice(0, 80),
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
    if (o.borderWidth) div.style.border = `${o.borderWidth * k}px solid ${o.borderColor || '#8b5cf6'}`;
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
      if (o.fontFamily) div.style.fontFamily = o.fontFamily;
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
    ${row('прозрачность', `<input type="range" id="aso-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="aso-op-val">${o.opacity}%</span>`)}
    <p class="hint">размер — ручкой ↘ в превью</p>
    ${row('прозрачность', `<input type="range" id="aso-op" min="0" max="100" value="${o.opacity}" /><span class="hint" id="aso-op-val">${o.opacity}%</span></div>`)}
    <div class="rp-row">
      <label class="hint">слой:</label>
      <button class="act ghost" id="aso-zup" title="поднять">▲</button>
      <span class="hint">z=${o.z}</span>
      <button class="act ghost" id="aso-zdown" title="опустить">▼</button>`;
  if (o.type === 'text') {
    html += row('текст', `<span class="hint">цвет</span><input type="color" id="aso-color" value="${esc(o.color || '#ffffff')}" /><span class="hint">шрифт</span><input type="number" id="aso-fs" min="10" max="60" value="${o.fontSize}" style="width:56px" />`);
    html += row('семейство шрифта', `<select id="aso-font" style="max-width:260px">${fontOptions(o.fontFamily)}</select>`);
  }
  html += row('закругление', `<input type="number" id="aso-radius" min="0" max="120" value="${o.radius}" style="width:56px" />`);
  html += row('грань (обводка)', `<span class="hint">цвет</span><input type="color" id="aso-b2color" value="${esc(o.borderColor || '#8b5cf6')}" /><span class="hint">толщ</span><input type="range" id="aso-bw" min="0" max="12" value="${o.borderWidth ?? 0}" style="width:90px" /><span class="hint" id="aso-bw-val">${o.borderWidth ?? 0}px</span>`);
  if (o.type === 'backdrop' || o.type === 'image') {
    html += o.type === 'backdrop' ? row('цвет', `<input type="color" id="aso-bcolor" value="${esc(o.color || '#0c0a19')}" />`) : '';
    html += `<label>картинка <select id="aso-img"></select></label>
      <div class="am-sound-row"><input type="file" id="aso-img-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="max-width:220px" /><button class="act ghost" id="aso-img-up">⬆</button></div>`;
  }
  html += `<button class="act ghost" id="aso-del">🗑 Удалить объект</button></div>`;
  props.innerHTML = html;

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
  $('#aso-font')?.addEventListener('change', () => { o.fontFamily = $('#aso-font').value; asoRenderStage(); });
  $('#aso-radius')?.addEventListener('pointerdown', asoPushThrottled);
  $('#aso-radius')?.addEventListener('input', () => { o.radius = Number($('#aso-radius').value) || 0; asoRenderStage(); });
  $('#aso-b2color')?.addEventListener('input', () => { o.borderColor = $('#aso-b2color').value; asoRenderStage(); });
  $('#aso-bw')?.addEventListener('input', () => {
    o.borderWidth = Number($('#aso-bw').value) || 0;
    $('#aso-bw-val').textContent = `${o.borderWidth}px`;
    asoRenderStage();
  });
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
  // под-вкладка «🌐 Прокси»
  const c = p.core ?? {};
  $('#px-enabled').checked = Boolean(p.enabled) && p.type !== 'socks5' && !['singbox', 'xray'].includes(p.type);
  $('#px-url').value = p.url ?? '';
  $('#px-socks-enabled').checked = Boolean(p.enabled) && p.type === 'socks5';
  $('#px-socks-host').value = p.socksHost ?? '';
  $('#px-socks-port').value = p.socksPort ?? 1080;
  $('#px-socks-user').value = p.socksUser ?? '';
  $('#px-socks-pass').value = p.socksPass ?? '';
  $('#px-core-enabled').checked = Boolean(p.enabled) && ['singbox', 'xray'].includes(p.type);
  $('#px-core-kind').value = p.type === 'xray' ? 'xray' : 'singbox';
  $('#px-core-binary').value = c.binaryPath ?? '';
  $('#px-core-sub').value = c.subUrl ?? '';
  $('#px-core-status').textContent = c.subName
    ? `узел: ${c.subName} (${p.enabled && ['singbox', 'xray'].includes(p.type) ? 'активен' : 'сохранён, ядро выключено'})`
    : 'узел ещё не выбран — обновь подписку';
  $('#px-mtproto-enabled').checked = Boolean(p.mtprotoEnabled);
  $('#px-mtproto-host').value = p.mtprotoHost ?? '';
  $('#px-mtproto-port').value = p.mtprotoPort ?? 443;
  $('#px-mtproto-secret').value = p.mtprotoSecret ?? '';
  $('#px-result').textContent = p.enabled ? '' : 'прокси выключен — бот ходит напрямую';
}

// HTTP-прокси (главный способ)
$('#px-save').addEventListener('click', async () => {
  try {
    await putSettings({ proxy: { enabled: $('#px-enabled').checked, type: 'http', url: $('#px-url').value.trim() } });
    toast('Прокси сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

// SOCKS5-прокси
$('#px-socks-save').addEventListener('click', async () => {
  try {
    await putSettings({
      proxy: {
        enabled: $('#px-socks-enabled').checked,
        type: 'socks5',
        socksEnabled: $('#px-socks-enabled').checked,
        socksHost: $('#px-socks-host').value.trim(),
        socksPort: Number($('#px-socks-port').value) || 1080,
        socksUser: $('#px-socks-user').value.trim(),
        socksPass: $('#px-socks-pass').value,
      },
    });
    toast('SOCKS5 сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

// 🔌 локальное ядро sing-box / Xray-core
$('#px-core-save').addEventListener('click', async () => {
  try {
    await putSettings({
      proxy: {
        enabled: $('#px-core-enabled').checked,
        type: $('#px-core-kind').value,
        core: {
          binaryPath: $('#px-core-binary').value.trim(),
          subUrl: $('#px-core-sub').value.trim(),
        },
      },
    });
    toast('Ядро сохранено ✅');
  } catch (e) { toast(e.message, true); }
});

$('#px-core-fetch').addEventListener('click', async () => {
  // сохранять не обязательно: подписка качается по сохранённому юрл
  toast('Качаю подписку…');
  try {
    const r = await api('/api/actions/proxysubupdate', { method: 'POST', body: '{}' });
    if (r.error) { toast(r.error, true); return; }
    toast(`Подписка: ${r.count} узлов, выбран «${r.picked}» (${r.kind}) ✅`);
    loadProxySettings().catch(() => {});
  } catch (e) { toast(e.message, true); }
});

// «Проверить связь» — в обоих местах вкладки (верх и ядро)
for (const id of ['#px-test', '#px-test2']) {
  document.querySelector(id)?.addEventListener('click', async () => {
    document.querySelector(id).textContent = 'Проверяю связь…';
    try {
      const r = await api('/api/actions/proxytest', { method: 'POST', body: '{}' });
      document.querySelector(id).textContent = 'Проверить связь';
      document.querySelector('#px-result').textContent = `${r.via} — «${r.sample}»`;
      toast(`✅ ${r.via} — YouTube доступен («${r.sample}»)`);
    } catch (e) {
      document.querySelector(id).textContent = 'Проверить связь';
      toast(`❌ ${e.message}`, true);
    }
  });
}

// MTProto (поля хранятся; конвертация — в планах)
$('#px-mtproto-save').addEventListener('click', async () => {
  try {
    await putSettings({
      proxy: {
        mtprotoEnabled: $('#px-mtproto-enabled').checked,
        mtprotoHost: $('#px-mtproto-host').value.trim(),
        mtprotoPort: Number($('#px-mtproto-port').value) || 443,
        mtprotoSecret: $('#px-mtproto-secret').value.trim(),
      },
    });
    toast('MTProto-поля сохранены ✅');
  } catch (e) { toast(e.message, true); }
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

// цвет ника бота: разовая операция по кнопке, в чат ничего не пишет
$('#bot-color-apply').addEventListener('click', async () => {
  const color = $('#bot-color').value;
  try {
    const r = await api('/api/actions/botcolor', { method: 'POST', body: JSON.stringify({ color }) });
    $('#bot-color-result').textContent = `Цвет применён: ${r.applied}`;
    toast('Цвет ника применён ✅');
  } catch (e) {
    $('#bot-color-result').textContent = `${e.message} — при ошибке скоупа нужен повторный вход бота`;
    toast(e.message, true);
  }
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
// загрузка вкладки музыки на старте панели: бот может быть в рестарте (секунды между
// «убит» и «поднят») — не требуем F5, дожимаем в фоне с ретраями
let sgBootTries = 0;
const bootSongsTab = async () => {
  try {
    await loadSongsTab();
  } catch (e) {
    sgBootTries++;
    console.error('loadSongsTab:', e); // стек — и единственный след, если это не сеть
    if (sgBootTries === 1) toast('Бот не отвечает — настройки музыки догрузятся сами, когда он поднимется', true);
    if (sgBootTries < 30) setTimeout(bootSongsTab, 5000);
  }
};
bootSongsTab();
loadProxySettings().catch(() => {});
loadQuotes().catch(() => {});
poll();
setInterval(poll, 2000);
