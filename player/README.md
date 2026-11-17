# 🎵 Папка плеера музыки — кастомизируй свободно

Вся страница `/music` (её добавляют в OBS как **Браузер-источник**) живёт здесь,
в одном файле **`index.html`** — дизайн и логика. Не нравится — правь или клади
свой целиком, бот не сломается.

## Что можно менять

- **Внешний вид** — CSS-переменные в начале `index.html`:
  ```css
  --pl-width: 640px;        /* ширина видео */
  --pl-accent: #8b5cf6;     /* цвет подсветки */
  --pl-text: #ffffff;       /* цвет бегущей строки */
  --pl-bg: rgba(10,8,20,.8);/* подложка */
  --pl-font-size: 22px;     /* текст строки */
  --pl-speed: 30s;          /* скорость бегущей строки (больше = медленнее) */
  --pl-align: center;       /* center | flex-start | flex-end */
  ```
- **Разметку и стили** — полностью свои
- **Логику** — если нужно; контракт ниже

## Контракт с ботом (единственное, что требует бот)

| Что | Куда |
|---|---|
| Состояние | `GET /api/songs` → `{ current, queue, paused, enabled, volume, nowTemplate }` |
| События (SSE) | `EventSource('/overlay/feed')`, см. ниже |
| «Трек закончился» | `POST /api/songs {op:'ended'}` |
| Вкл/выкл музыки | `PUT /api/settings {songs:{enabled:true/false}}` |

События SSE:

```
{ kind:'sr', op:'play'|'stop'|'update'|'pause'|'resume',
  current: { id, title, author, duration, by, byName },
  volume, nowTemplate, paused }

{ kind:'srtest', op:'play'|'pause'|'resume'|'stop', id, title, volume }
   — «Тест плеера» из панели: играет трек мимо очереди
```

`nowTemplate` — шаблон бегущей строки, переменные:
`{title}` `{by}` `{author}` `{duration}`.

`current.id` — ID видео YouTube (11 символов), проигрывается через
YouTube IFrame API (`https://www.youtube.com/iframe_api`).

## Проверить дизайн без стрима

Открой `http://localhost:8080/music?…` в браузере и жми «🧪 Тест плеера»
в панели — трек заиграет и здесь.
