/**
 * Пример модуля для бота. Копируй, переименовывай, меняй под себя —
 * правки подхватываются на лету, перезапускать бота не нужно.
 * Полный разбор — в README, раздел «Модули».
 */
export default {
  // имя для панели (дефолт — имя файла)
  name: 'example',
  description: 'пример: команда !факт и !печенька с текстом из настроек',

  // настройки по умолчанию — их можно менять в панели, вкладка «🧩 Модули»
  settings: {
    печенька: '🍪 {user} угощает {target} печенькой!',
    сообщение: 'модуль example живой',
  },

  // декларативные команды: строка = простой текст-ответ,
  // объект = полная схема как у фан-команд (mode/variants/roll/needsTarget/...)
  commands: {
    'факт': '{user}, котики мурчат на частоте 25–150 Гц 🐱',
    'печеньимворлд': { mode: 'roll', rollMin: 0, rollMax: 100, chance: 100, cooldown: 5, response: '{user} стал печенькой на {roll}%', ranges: [
      { from: 0, to: 33, text: '{user} слегка посыпан мукой: {roll}% печеньки 🥐' },
      { from: 34, to: 66, text: '{user} наполовину печенька: {roll}% 🍪' },
      { from: 67, to: 100, text: '{user} — просроченное печенько: {roll}% 🍪💀' },
    ] },
  },

  // хуки на события: async (событие, api) => {}
  // api: say/announce/pin/shoutout, settings, saveSettings(), channel, channels(), log()
  events: {
    'chat.message': async (m, api) => {
      const text = String(m?.message?.text ?? '');
      if (!text.startsWith('!печенька')) return;
      const target = (text.split(/\s+/)[1] ?? m.chatter_user_name).replace(/^@/, '');
      const line = String(api.settings['печенька'] ?? '🍪 {user} угощает {target} печенькой!')
        .replaceAll('{user}', m.chatter_user_name)
        .replaceAll('{target}', target);
      api.log(`печенька для ${target} в #${api.channel}`);
      await api.say(line);
    },
  },
};
