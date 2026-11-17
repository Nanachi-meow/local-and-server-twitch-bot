/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ЗАМЕНЯЕМЫЙ ПЛЕЕР МУЗЫКИ — правь этот файл как угодно, оверлей не сломается.
 *  Контракт (единственное, что требует /music и /overlay):
 *    window.srPlayer = {
 *      role: 'player' | 'label',   // player = играет звук, label = только надпись
 *      init(state),                // вызывается при загрузке: { current, queue, paused, enabled, volume, nowTemplate }
 *      onEvent(ev),                // события SSE: ev.kind === 'sr', ev.op === 'play' | 'stop' | 'update' | 'pause' | 'resume'
 *    }
 *  API сервера: GET /api/songs (состояние), POST /api/songs {op:'ended'} — закончился трек.
 * ═══════════════════════════════════════════════════════════════════════════
 */
(() => {
  const params = new URLSearchParams(location.search);
  // роль: страница /music = player (звук), оверлей = label (только надпись)
  const role = document.body.dataset.srRole === 'player'
    ? 'player'
    : (params.get('role') === 'player' ? 'player' : 'label');

  let yt = null;           // YouTube-плеер (только в роли player)
  let volume = 60;
  let nowTemplate = '♪ {title} — заказал {by}';
  let current = null;
  let lastVideoId = null;

  // ---------- оформление «сейчас играет» — К А С Т О М И З И Р У Й ----------
  function render() {
    const el = document.getElementById('sr-now');
    if (!el) return;
    if (!current) { el.classList.add('hidden'); return; }
    const text = nowTemplate
      .replaceAll('{title}', current.title || '')
      .replaceAll('{by}', current.byName || current.by || '')
      .replaceAll('{author}', current.author || '')
      .replaceAll('{duration}', formatTime(current.duration || 0));
    el.innerHTML = `<span class="sr-icon">🎵</span> ${escapeHtml(text)}`;
    el.classList.remove('hidden');
  }
  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- YouTube IFrame API (роль player) ----------
  function ensureApi() {
    if (role !== 'player' || yt) return;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      yt = new YT.Player('sr-video', {
        width: 320, height: 180, playerVars: { controls: 0, playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => { if (current) playCurrent(); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) {
              fetch('/api/songs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'ended' }) })
                .then((r) => r.json()).catch(() => {});
            }
          },
        },
      });
    };
  }

  function playCurrent() {
    if (!yt || !current) return;
    if (lastVideoId === current.id) { yt.playVideo(); return; }
    lastVideoId = current.id;
    yt.loadVideoById(current.id);
    yt.setVolume(volume);
    yt.playVideo();
  }

  // ---------- публичный контракт ----------
  window.srPlayer = {
    role,
    init(state) {
      volume = Math.max(0, Math.min(100, Number(state?.volume ?? 60)));
      nowTemplate = String(state?.nowTemplate || nowTemplate);
      current = state?.current ?? null;
      render();
      if (role === 'player') ensureApi();
    },
    onEvent(ev) {
      // тест плеера: играет трек мимо очереди (событие сервиса, не заказа)
      if (ev?.kind === 'srtest') {
        if (role !== 'player') return;
        volume = Math.max(0, Math.min(100, Number(ev.volume ?? volume)));
        ensureApi();
        if (yt && ev.id) {
          try {
            yt.loadVideoById(ev.id);
            yt.setVolume(volume);
            yt.playVideo();
          } catch {}
        }
        return;
      }
      if (!ev || ev.kind !== 'sr') return;
      volume = Math.max(0, Math.min(100, Number(ev.volume ?? volume)));
      nowTemplate = String(ev.nowTemplate || nowTemplate);
      current = ev.current ?? null;
      render();
      // громкость применяется сразу (ползунок в панели), не только при загрузке трека
      if (yt && typeof yt.setVolume === 'function') {
        try { yt.setVolume(volume); } catch {}
      }
      if (role !== 'player') return;
      ensureApi();
      if (ev.op === 'play' && yt && current) playCurrent();
      else if (ev.op === 'pause' && yt) yt.pauseVideo();
      else if (ev.op === 'resume' && yt) yt.playVideo();
      else if (ev.op === 'stop' && yt) { yt.stopVideo(); lastVideoId = null; }
    },
  };

  // стартовое состояние
  fetch('/api/songs').then((r) => r.json()).then(window.srPlayer.init).catch(() => {});
})();
