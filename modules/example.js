/**
 * Пример модуля: команды (строка + async-функция), хуки, хранилище, lifecycle.
 * Копируй, переименовывай, меняй под себя — правки подхватываются на лету.
 *
 * ПОЛНЫЙ справочник API (helix/store/fetch/obs/overlay/таймеры/события) —
 * в modules/vip-activity.js (гайд в шапке) и в ДОКУМЕНТАЦИЯ.md → «Модули».
 */
export default {
  // имя для панели (дефолт — имя файла)
  name: 'example',
  description: 'пример: команды, хуки, хранилище, Helix API',
  // пример-гайд: по умолчанию выключен, чтобы не путался под ногами
  // (включается галочкой в панели → 🧩 Модули)
  enabled: false,

  // настройки по умолчанию — правятся в панели, вкладка «🧩 Модули»
  settings: {
    приветствие: 'Привет, {user}!',
  },

  // lifecycle: вызывается при загрузке и включении модуля
  async start(api) {
    api.log('example загружен');
    // пример managed-интервала: очищается автоматически при остановке модуля
    api.setInterval(() => {}, 60_000);
  },

  commands: {
    // 1) строка = простой текст-ответ (шаблонные переменные работают)
    'факт': '{user}, котики мурчат 🐱',

    // 2) async-команда — полный доступ к API модуля
    'профиль': async (session, args, api) => {
      const target = args[0]?.replace(/^@/, '') || session.login;
      const u = await api.helix.get('/users', { login: target });
      if (u?.data?.[0]) {
        await api.say(`${u.data[0].display_name} — ID ${u.data[0].id}, создан ${u.data[0].created_at?.split('T')[0]}`);
      } else {
        await api.say(`Не нашла ${target} 🤷`);
      }
    },

    // 3) счётчик вызовов через персистентное хранилище (переживает рестарт)
    'счёт': async (session, _, api) => {
      const n = (api.store.get('count', 0) || 0) + 1;
      api.store.set('count', n);
      await api.say(`!счёт вызван ${n} раз(а)`);
    },
  },

  events: {
    // хуки: async (событие, api) => {} — return false заблокирует событие
    'chat.message': async (m, api) => {
      if (m?.message?.text === '!пинг') await api.say('понг от example-модуля!');
    },
  },

  // lifecycle: вызывается при выключении/перезагрузке — чистим и сохраняемся
  async stop(api) {
    api.store.save();
  },
};
