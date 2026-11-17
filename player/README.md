# 🎵 Папка плеера музыки — кастомизируй свободно

Вся страница `/music` (её добавляют в OBS как **Браузер-источник**) живёт здесь,
в одном файле **`index.html`** — дизайн и логика. Не нравится — правь или клади
свой целиком, бот не сломается.

## Что можно менять

- **Внешний вид** — прямо в панели бота: 🎵 Музыка → «📐 Раскладка плеера»
  (объекты двигаются мышкой, слои, прозрачность, свои картинки)
- **Разметку и стили** — полностью свои
- **Логику** — если нужно; контракт ниже

## Раскладка (playerCfg.objects)

Плеер — набор объектов на сцене 1920×1080, каждый задаётся в px:

```
{ type: 'video' | 'marquee' | 'backdrop' | 'image',
  x, y, w, h,            // позиция и размер, px
  opacity: 0-100,         // прозрачность
  z: 0-30,                // слой (больше = выше)
  hideOnIdle: bool,       // прятать, когда ничего не играет
  radius: px,             // закругление (кроме video/marquee)
  image: 'файл из overlay-media/',   // для backdrop/image
  color: '#rrggbb',       // для backdrop (без картинки) и marquee (текст)
  fontSize: px, speed: сек // только marquee
}
```

## Контракт с ботом (единственное, что требует бот)

| Что | Куда |
|---|---|
| Состояние | `GET /api/songs` → `{ current, queue, paused, enabled, volume, nowTemplate, playerCfg }` |
| События (SSE) | `EventSource('/overlay/feed')`, см. ниже |
| «Трек закончился» | `POST /api/songs {op:'ended'}` |
| Вкл/выкл музыки | `PUT /api/settings {songs:{enabled:true/false}}` |

События SSE:

```
{ kind:'sr', op:'play'|'stop'|'update'|'pause'|'resume',
  current, volume, nowTemplate, paused, playerCfg }

{ kind:'srtest', op:'play'|'pause'|'resume'|'stop', id, title, volume }
   — «Тест плеера» из панели: играет трек мимо очереди
```

`nowTemplate` — шаблон бегущей строки, переменные:
`{title}` `{by}` `{author}` `{duration}`.

`current.id` — ID видео YouTube (11 символов), проигрывается через
YouTube IFrame API (`https://www.youtube.com/iframe_api`).

## Проверить дизайн без стрима

Открой `http://localhost:8080/music` в браузере и жми «🧪 Тест плеера»
в панели — трек заиграет и здесь.
