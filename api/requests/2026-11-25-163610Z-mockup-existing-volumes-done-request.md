# Запрос от команды mockup: хранилище на томах с записями внесено (findVolumes, attachExisting, профиль vms.volume/1 1.3) — проверить

2026-11-25 · коммит `ed4fc16` · от команды mockup

Кому: w2c, владелец контракта

**Статус: новый**

## Что мы сделали

Мы сделали пункт `B4` отчёта о пробелах против Axxon One ([`docs/axxon-one-gaps.html`](../../docs/axxon-one-gaps.html)): «Хранилище на существующих томах». Мы работали по [запросу 144153Z](2026-11-12-144153Z-mockup-existing-volumes-request.md) и [ответу владельца от 2026-11-17](2026-11-12-144153Z-mockup-existing-volumes-response.md). Владелец решил: п. 1 и п. 2 — новое поведение сервера, mockup делает их с уведомлением; пп. 3–4 — данные вида. Поля входят в профиль `vms.volume/1` (owner mockup), поэтому правку проверяют его reviewers — w2c. Слой правки называет `tools/layers.py`: «уведомить w2c (vms.volume/1)», «уведомить владелец контракта».

- Профиль `vms.volume/1` 1.3 ([`api/profiles/vms.volume.json`](../profiles/vms.volume.json), таблица [`vms.volume.md`](../profiles/vms.volume.md)): `attachExisting`, `recordsFrom`, `recordsTo`.
- Вид `volume` и команда `findVolumes` видов `archive.local` и `archive.network` — в `api/fixtures/demo.json`. Описание — [`api/BACKEND.md`](../BACKEND.md), абзац «Том».
- Сервер стенда — `api/profiles.js`: `foundOnServer`, `foundOnNas`, `archiveFind`, `volumeAttachProblem`. `api/openapi.json` правка не трогает: путь `POST /kinds/{kind}/actions/{action}` уже есть. Контракт остаётся 0.39.0.
- Интерфейс — `index.html`: мастер «Новое хранилище», шаг «Первый том», вариант «Том с записями», и окно «＋ Том». Список томов теперь приходит от сервера, а не из браузера. На Pages: https://ndm234234.github.io/consolem/index.html.
- Тесты: `tests/api-archive.js`, тест «Том: с записями (профиль 1.3)…». Слой — `profile:vms.volume/1`, нужны `action:archive.local/findVolumes` и `prop:volume.attachExisting`: бэкенд без них тест пропускает. Сценарий интерфейса — шаги в `tests/ui-storage.js`.

## Что проверить

По пунктам запроса 144153Z:

1. **`attachExisting`** (п. 1) — свойство тома с `x-transient`, как `confirmShrinkBytes`. Сервер судит его в `POST /units`, не хранит и не отдаёт. С `true` сервер подключает том без форматирования: `state: ready`, а не `unfmt`. Объём тома (`sizeBytes`) сервер берёт свой, а не из запроса. Новых кодов отказа нет: нет тома по адресу — `422 VALIDATION_FAILED`, `field: /properties/attachExisting`, `params.reason: notFound`; тип хранения не тот — `params.reason: storageMismatch`. Без поля сервер работает, как раньше. Ваш бэкенд может подключить раздел SolidStore, файл `.afs` и папку объектного хранилища без форматирования?
2. **`findVolumes`** (п. 2) — команда вида со `scope: ["kind"]`, `execution: instant`. Параметры: `serverId` — у `archive.local` обязателен; `disk`, `login`, `password` — папка NAS у `archive.network`, там `serverId` необязателен. Результат — `items`: `disk`, `mode` (`part` / `file` / `dir`), `dir`, `file`, `sizeBytes`, `storage` (`block` / `object`), `recordsFrom`, `recordsTo`, `archiveName`, `serverName`, `recordsVisible`. Тома, которые уже подключили хранилища, в список не входят. Сканировать диски — долго? Если да, нужен ли вам `execution: longRunning`?
3. **`recordsFrom`, `recordsTo`** (п. 3) — свойства тома только для чтения, `date-time`. Сервер ставит их при подключении с `attachExisting`. Форматирование (`format`) стирает записи и оба поля.
4. **Имя сервера записи** (п. 4) — `serverName` и `recordsVisible` в ответе `findVolumes`. `recordsVisible` — имя сервера записи то же, что у `serverId`. Нет `serverId` — поля нет. Консоль предупреждает, если записи не будут видны.
5. **Тесты** (п. 5) — все три случая ответа владельца в одном тесте, и ещё: подключённый том больше не найден; форматирование стирает период; NAS без учётной записи — 422.

## Сверх запросов

- Команда объявлена только у `archive.local` и `archive.network`. У `backup`, `edge`, `incidents` её нет, поэтому окно «＋ Том» у них сразу добавляет новый том, без выбора «Новый том / Том с записями».
- `attachExisting` у вида без `findVolumes` сервер не отвергает отдельным кодом. Он сверяет адрес с тем же списком: у бакета списка нет, ответ — `notFound`.
- Встроенный сервер диски не сканирует. Список он строит по дискам сервера и пути NAS одним правилом: так список одинаковый на любом наборе. В папке NAS — два файла `.afs` (блочное) и папка объектного хранилища.
- Сервер стенда сам ставит `usedPercent: 64` у подключённого тома: на томе уже есть записи.
