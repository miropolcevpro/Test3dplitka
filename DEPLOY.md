# Deploy (GitHub Pages + Tilda iframe)

1. Замените файлы в репозитории GitHub Pages на содержимое этого архива (с сохранением структуры каталогов).
2. Дождитесь обновления GitHub Pages.
3. Обновите страницу Tilda (iframe) и очистите кэш (Ctrl+F5).

## Важные требования

- Требуется **WebGL2** (современный Chrome/Edge/Яндекс.Браузер/Safari). Рендер теперь выполняется только через WebGL.
- Текстуры из Yandex Object Storage должны загружаться с **CORS** для вашего домена (иначе WebGL заблокирует загрузку текстур).
  - Минимально: `Access-Control-Allow-Origin: *` (или конкретный домен) + `Access-Control-Allow-Headers: *`.

## Release preset P01

- Введён единый `release_config.js` для инвентаризации ship-ready и экспериментальных функций.
- В публичном release-core пресете принудительно отключены: multi-zone, split-zone, object occlusion, manual 3D calibration, AI debug overlay, debug metrics и dev URL flags.
- Premium Ultra оставлен доступным как advanced-only функция.

## Patch P02 — state/reset hardening

- Дефолты материала переведены в единый источник истины (`state.js`), включая согласованный `horizon`.
- Новый проект, новая фотография и сброс зоны теперь используют общие reset-хелперы вместо разрозненных локальных значений.
- При reset очищаются остаточные UI/AI-состояния: drag/select, pointer capture, split draft, depth/occlusion runtime, авто/ручная калибровка и временные статусы.

## Быстрый чек-лист после деплоя

- После загрузки новой фотографии новый контур начинается сразу, без «залипшего» состояния.
- После `Сбросить проект` фото очищается, снова открывается чистый шаг загрузки, а новый контур работает штатно.
- После `Сбросить участок` зона пересобирается с чистым контуром, но без потери выбранного материала.
- Horizon/perspective после reset стартуют одинаково для новой зоны, новой фотографии и сброса участка.
- Export PNG и обычный выбор текстур/форм продолжают работать как раньше.


## Patch P03 — single-zone release hardening

- Single-zone runtime теперь нормализуется жёстко: в боевом режиме всегда сохраняется только один основной участок.
- Принудительно отключены runtime-переходы в split/multi-zone сценарии, а edit scope зафиксирован в режиме `Текущий участок`.
- Убран остаточный linked-zone смысл для single-zone release: основной участок больше не несёт скрытую зависимость от multi-zone логики.
- UI и runtime дополнительно защищены от случайного дублирования/удаления/разделения участков в публичной сборке.


## Patch P04 — asset delivery hardening

- `shapes.json` теперь загружается только из локальных статических кандидатов (`shapes.json`, `data/shapes.json`, `frontend_github_pages/shapes.json`). Legacy fallback на внешние GitHub Pages отключён.
- Поставлен allowlist по origin для ассетов релиза: локальный origin, Yandex Object Storage, production gateway и ограниченный список runtime/CDN-источников для AI-вендоров.
- Текстуры переведены в строгий **CORS-only** режим без тихого no-CORS fallback в публичной сборке. Это нужно, чтобы исключить «рендер есть, а PNG export внезапно таinted/сломался».
- Палитры/текстуры, у которых albedo/maps ведут на origin вне allowlist, скрываются из каталога вместо неявной загрузки из произвольных URL.
- AI runtime/model delivery (ORT / MediaPipe / OpenCV worker candidates) теперь проходят через ту же release-политику origin allowlist.

## Дополнительные требования после P04

- `shapes.json` должен лежать рядом с редактором либо в одном из локальных статических путей из release policy.
- Все texture maps и preview должны приходить с production-origin, у которого корректно настроен CORS для вашего домена/iframe.
- Для полного production hardening рекомендуется в следующих релизах self-host:
  - `earcut`
  - `onnxruntime-web` bundle + wasm
  - `opencv.js`
  - MediaPipe runtime assets
  - depth / segmentation models

## Быстрый чек-лист P04 после деплоя

- формы грузятся из локального `shapes.json`, без обращения к legacy GitHub fallback;
- палитра формы открывается, а каталог не показывает текстуры с неразрешённых origin;
- при неверном CORS текстуры не подгружаются «тихо», а дают понятную ошибку в статусе/консоли;
- PNG export продолжает работать на корректно настроенных production-ассетах;
- Ultra не использует runtime/model URL вне allowlist release policy.


## Patch P05 — capability matrix + graceful degradation

- Добавлена release-матрица возможностей устройства: `Safe / Reduced / Full`.
- Профиль определяется по WebGL2/WebGPU, памяти, числу потоков CPU, touch/mobile-профилю и размеру загруженной фотографии.
- `Full`: Premium Ultra доступен без упрощений.
- `Reduced`: Ultra остаётся доступным, но по умолчанию не форсируется и работает в облегчённом профиле.
- `Safe`: тяжёлые AI-операции автоматически отключаются, продукт остаётся в стабильном базовом сценарии без поломки основного UX.
- AI status теперь отражает capability tier, а переключатель Ultra автоматически блокируется на устройствах, не прошедших capability-gate.
- Глубинная AI-стадия теперь учитывает capability profile: safe-профиль пропускает depth stage полностью, reduced-профиль использует облегчённый путь.

## Быстрый чек-лист P05 после деплоя

- на слабом устройстве / очень большой фотографии Ultra автоматически недоступен, но базовый сценарий загрузка → контур → материал → экспорт работает;
- на среднем устройстве Ultra виден, но не должен перегружать интерфейс и должен работать мягче;
- на сильном устройстве Ultra остаётся доступным в полном профиле;
- статус AI показывает не только состояние, но и tier (`Safe` / `Reduced` / `Full`);
- при авто-даунгрейде не ломается рендер и не «залипают» material params между base/ultra.

## Patch P06 — error reporting + diagnostics
- Added `js/diagnostics.js` with bounded session diagnostics buffer, global `error` / `unhandledrejection` capture, and JSON snapshot export.
- Footer now includes **Копировать диагностику** to copy a support snapshot with build info, browser, viewport, release flags, current mode, capability tier, loaded asset ids, and recent critical errors.
- Asset loading, WebGL render/init/context loss, export failures, bootstrap failures, and AI pipeline errors now write structured diagnostics entries.
- Updated public release patch marker to `P06`.


## Patch P07 — analytics events foundation

- Добавлен новый модуль `js/analytics.js` с единым analytics event bus, локальной очередью событий и persisted queue в `localStorage` для отладки/дальнейшего подключения транспорта.
- Введены базовые product events public release-контура: `photo_upload_started`, `photo_upload_success`, `contour_started`, `contour_completed`, `cutout_started`, `texture_selected`, `compare_opened`, `export_clicked`, `export_success`, `advanced_mode_opened`, а также авто-трекинг `render_error` / `export_error` / `init_error` / `ai_error` из diagnostics.
- Diagnostics snapshot теперь включает analytics summary: counters, recent events и размер pending queue.
- Analytics foundation не отправляет данные во внешний endpoint: P07 безопасно собирает и нормализует события локально, не меняя базовый пользовательский сценарий.

## Быстрый чек-лист P07 после деплоя

- после загрузки фото в локальной analytics-очереди появляются события `photo_upload_started` и `photo_upload_success`;
- при первой постановке точки контура появляется `contour_started`, после замыкания — `contour_completed`;
- при выборе текстуры появляется `texture_selected`;
- при открытии режима `Просмотр` появляется `compare_opened`;
- при открытии дополнительных настроек появляется `advanced_mode_opened`;
- при экспорте PNG появляются `export_clicked` и `export_success`;
- diagnostics snapshot содержит секцию `analytics`.


## Patch P08 — guided simple mode shell

- Введён guided simple shell с 4 публичными шагами: `Фото → Зона → Плитка → Результат`. Stepper и верхняя guidance-панель теперь показывают только этот массовый сценарий вместо внутренних технических состояний.
- Добавлен contextual primary action button: в зависимости от шага он ведёт пользователя к загрузке фото, продолжению контура, выбору плитки или чистому результату/PNG.
- Вторичные инструменты (`Вырезы` + кнопка режима `Вырез`) скрыты по умолчанию и открываются только через `Доп. инструменты`, чтобы не перегружать дефолтный пользовательский сценарий.
- Advanced-панель при этом сохранена: P08 упрощает shell/UI-контур, но не ломает advanced-возможности и не меняет базовый рендер.

## Быстрый чек-лист P08 после деплоя

- вверху после stepper появился guided simple shell с текущим шагом и основной кнопкой действия;
- шаги читаются как `1 Фото / 2 Зона / 3 Плитка / 4 Результат`;
- после загрузки фото shell переводит пользователя к контуру;
- после замыкания контура shell ведёт к выбору формы/плитки;
- после выбора текстуры shell предлагает открыть результат или скачать PNG;
- `Вырезы` и кнопка `Вырез` скрыты до открытия `Доп. инструменты`;
- базовый сценарий загрузка → контур → плитка → просмотр/export остаётся рабочим.
