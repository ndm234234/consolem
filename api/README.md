# API конфигуратора

Прототип API — это основной макет `index.html` (Pages: `https://ndm234234.github.io/consolem/index.html`) с **универсальной моделью объектов**: ядро `/kinds` + `/units` и профили вместо путей по видам. Он задаёт поведение и служит эталоном для проверки; в продукт его код не переносят ([FRONTEND.md](FRONTEND.md)). Своих данных у интерфейса нет: всё, что в продукте хранит бэкенд, интерфейс читает и меняет запросами контракта [`openapi.json`](openapi.json). Контракт — версия `0.2.0`, несовместимая с контрактом старого макета (`0.1.0`, пути по видам `/devices`, `/servers`…): что снято и чем заменено — «[Ломающие изменения против контракта старого макета (до 0.2.0, коммит 47d1310)](#ломающие-изменения-против-контракта-старого-макета-до-020-коммит-47d1310)». Старый макет и его контракт остались только в истории git: `git show 47d1310:api/openapi.json`. Решение целиком — [`docs/superpowers/specs/2026-11-03-generic-model-design.md`](../docs/superpowers/specs/2026-11-03-generic-model-design.md); запрос и ответ о модели — [`requests/2026-11-03-065231Z-mockup-generic-model-*.md`](requests/2026-11-03-065231Z-mockup-generic-model-request.md).

Зачем: виды объектов расширяемых VMS (плагины psim в NGP, подсистемы w2c) появляются после выпуска WebUI. Сервер отдаёт описания видов, интерфейс строит дерево, мастер, фильтры, подписи и форму по ним; у известных видов остаются ручные экраны, привязанные к **профилю** (`vms.camera/1`…), а не к виду. Объект незнакомого вида показывается, создаётся, правится, удаляется, получает команды, участвует в правилах и правах без кода интерфейса под вид.

**Где команды.** Инструменты `tools/*.py` по умолчанию работают с основным макетом: `index.html`, `api/`, `tests/` — без параметров. Прототип проверяют с `--page index_NN_….html` (его API и сценарии — общие с `index.html`). Все команды — «[Проверки](#проверки)» и [TESTS.md](TESTS.md).


## Как устроено

```
интерфейс (index.html)
   │  кэш прочитанного: дерево, карточки, черновики — меняется только ответом сервера или событием потока
   ▼
клиент API (client.js) ── ?api=https://… ──▶ бэкенд (fetch + SSE)
   │ по умолчанию
   ▼
встроенный сервер (server.js поверх kinds.js, units.js, profiles.js + rule-engine.js) — та же вкладка, данные — эталонный набор (fixtures/demo.json)
```

- **Контракт ведёт владелец макета в этом репозитории.** `api/openapi.json`, сервер и наборы правит владелец макета в `ndm234234/consolem`; altumur и команды VMS присылают изменения [запросами](requests/README.md) в `api/requests/`, порядок — там же. Перевод `backend` (V/11) держит копию контракта по коммиту.
- **Контракт — источник истины.** Если встроенный сервер расходится с `openapi.json`, ошибка в сервере. Встроенный сервер проверяет тела запросов по контракту (`contract.js`): что не подходит под схему, получает `422 VALIDATION_FAILED`.
- **Интерфейс говорит только с клиентом API.** Ответ встроенного сервера приходит обещанием и копируется — «как по сети». В интерфейсе есть кэш прочитанного: рендер читает его синхронно, а меняют кэш только ответы сервера и события потока.
- **По умолчанию запросы только изображаются.** В сеть клиент не ходит: он вызывает функцию `server.handle(метод, путь, тело, заголовки)` в той же вкладке и получает статус, тело и заголовки, как от HTTP. В DevTools → Network их не видно. С `?api=https://адрес` тот же клиент делает настоящий `fetch`. Пошагово, с кодом — в [BACKEND.md, «Запрос без сети»](BACKEND.md#запрос-без-сети-что-именно-происходит).
- **С диска и с сайта.** Всё подключается обычными `<script>`. Контракт и набор подключаются собранными `openapi.js` и `fixture.js`: с `file://` загрузить JSON через `fetch` нельзя.
- **Режимы страницы:**
  - `?api=https://адрес` — работать с настоящим бэкендом;
  - `?latency=300` — задержка ответа, как в медленной сети;
  - `?drop=listRules,getSettings` — система, которая не объявила эти операции: запуск без необязательного;
  - `?fixture=one-domain` — встроенный сервер с набором профиля: система, которая умеет часть контракта, и интерфейс без неподдержанного;
  - `?assist=https://адрес` — ход ассистента идёт в службу с настоящей моделью, со снимком встроенного сервера: только встроенный сервер и набор `demo`; код доступа нужен, только если служба ответила `401` (`BACKEND.md`, «Служба демо-страницы»). Метка страницы `consolem-assist` — то же адресом в разметке, в `index.html` её нет. В учебном режиме (`?demo`, раздел «Обучение») службы нет ни из `?assist=`, ни из меток: отвечает встроенная заглушка;
  - `?tour=<тема>&ch=<глава>&demo=` — учебный показ главы по устойчивым ID (`assets/tour.js`); `&demoFail=server|storage` — проверка отказа показа: сервер показа не загрузился, хранилище не отделилось;
  - `?selftest` — самопроверка (см. «Проверки»).

## Файлы

| Файл | Что это |
|---|---|
| `openapi.json` | Контракт, OpenAPI 3.1: операции, схемы, коды ошибок, сообщения потока |
| `fixtures/demo.json` | Эталонный набор: `kinds`, `profiles`, `units` вместо разделов по видам, остальное — в виде ответов API. Его загружают встроенный сервер и тестовый стенд бэкенда. Система с ним умеет весь контракт. Правится руками |
| `fixtures/one-domain.json` | Набор профиля «один домен»: система, которая умеет часть контракта. Собирается из `demo.json` (`python3 tools/profile_fixture.py`), руками не правится |
| `fixtures/large.json` | Стенд большого домена: 250 000 камер, 500 серверов. В файле только числа, записи считает заглушка при загрузке. Собирается `python3 tools/profile_fixture.py` |
| `fixtures/xl.json` | Стенд xl: `large` с другими числами — 1 000 000 камер, 2 000 серверов, 1 200 папок в четырёх доменах по 250 000 камер. В файле только наложение на `large` (`"$base"`, `stand`). Собирается `python3 tools/profile_fixture.py` |
| `client.js` | Клиент API: встроенный сервер или бэкенд, ответы — обещанием, ошибка — `{status, problem}` |
| `whep-stub.js` | Подставной WHEP стенда: на адрес `stub://` отвечает сама страница тестовой картинкой; куски записи — `assets/stub-piece.mp4` |
| `server.js` | Встроенный сервер: маршруты, операции, поток событий и групповые операции на своих часах, предметные API — поверх `kinds.js`, `units.js`, `profiles.js` |
| `kinds.js` | `window.ConsolemKinds`: реестр описаний видов, ETag (хэш описаний), родители и `creatable`, проверка `properties` по схеме вида с указателями (`/properties/…`), класс доступа |
| `units.js` | `window.ConsolemUnits`: склад `Unit` с индексами по `uid`, `parentId`, `kind`, `domainId`, ссылкам `x-ref` и папкам; страницы по курсору |
| `profiles.js` | `window.ConsolemProfiles`: хуки профилей — смысл, который из схемы не вывести (запись камеры и хранилища, каскады, детекторы, PTZ, тома); контракт хука — [BACKEND.md, «Хуки профилей»](BACKEND.md#хуки-профилей) |
| `plugins/` | Исходники незнакомых видов набора: манифест и переводы `security_controller` (psim), по ним заведены виды `security_controller/*` в `demo.json`; инструменты их не читают |
| `rule-engine.js` | Движок «Автоматизации» встроенного сервера: действует ли расписание, какой режим объекта, что сделает правило при запуске (трасса кодами), проверка правила. Им же посчитаны демо-запуски набора |
| `contract.js` | Сверка значения со схемой контракта: тела запросов (сервер), ответы (тесты). Сверх старого контракта — `if/then`, `dependentSchemas`, `readOnly`, `writeOnly`, `const`, `maxLength`, `maxItems`, `maximum` для схем видов |
| `openapi.js`, `fixture.js` | Собираются `python3 tools/build_api.py`, руками не правятся |
| `INVENTORY.md` | **Исторический**: инвентарь прототипа 09 перед первой переделкой: откуда взялись данные «Оборудования», «Прав», «Опций». «Автоматизацию» основного макета он не описывает — она в контракте и `BACKEND.md` |
| `BACKEND.md` | Памятка для команды бэкенда |
| `FRONTEND.md` | Памятка для команды фронтенда: для чего прототип и для чего нет, что повторить, что не переносить |
| `ACCEPTANCE.md` | Критерии приёмки интерфейса — шагами пользователя, для проверки реализации на любом стеке |
| `TESTS.md` | Какие тесты и проверки есть, что каждая проверяет и как запустить; что делает `?selftest` |
| `requests/` | Запросы к API от команд VMS и ответы на них; запрос на эту модель — `2026-11-03-065231Z-mockup-generic-model-*.md` |

## Карта API — 121 операция и 5 служебных

Путей по видам старого контракта нет: домены, серверы, устройства, папки, хранилища, тома и потоки камер — объекты `/units` своих видов. Адрес предметных API — по `uid`, доступность — профилем. Что чем заменено — «[Ломающие изменения](#ломающие-изменения-против-контракта-старого-макета-до-020-коммит-47d1310)».

| Раздел (тег) | Операции |
|---|---|
| `session`, `reference` | `GET /me` — кто вошёл, часы и часовой пояс сервера; `GET /reference` — справочники кодами и `capabilities` |
| `units` — ядро | `GET /kinds` (описания видов, ETag, `If-None-Match` → 304), `GET /kinds/{kind}`, `POST /kinds/{kind}/actions/{action}` (команда вида без объекта: опрос адреса, проверка NAS); `GET /units` (отборы `kind`, `parentId`, `domainId`, `implements`, `ref`, `folderId`, `ids`, `q`, `fields`, `noFolder`, `noRecord`, `noDetector`, `status`, страницы); `POST /units` (группой, `idempotencyKey`, вложенные дети, частичный успех `done`/`failed`); `GET`, `PATCH` (JSON Merge Patch, `If-Match`), `DELETE /units/{uid}`; `POST /units/{uid}/move` (в другого родителя, домен, сервер); `POST /units/{uid}/actions/{action}`; `GET /units/{uid}/creatable` (что можно завести под объектом); `GET /units/{uid}/schema` (схема конкретного объекта); `POST /units/validate` (проверить без записи) |
| `hardware` — дерево, папки, ретрансляторы | `GET /tree/children` (дети узла, страницами; раскладки `folders`, `servers`, `archives`, `detectors`); `GET /tree/paths` (цепочки от корня до объектов); `POST /objects/delete` (групповое удаление объектов любых видов по `uid`); `GET /domains/{id}/relays`, `GET /domains/{id}/relays/{name}` |
| `hardware` — предметные API по `uid` | живое видео `POST`, `PUT /units/{uid}/live`; разговор `POST /units/{uid}/talk`; архив `GET /units/{uid}/timeline`, `/playback`, `POST /units/{uid}/archive-fetch`; удержания `GET`, `POST /units/{uid}/holds`, `DELETE /holds/{id}`, `POST /holds/{id}/verify`; закладки `GET`, `POST /units/{uid}/bookmarks` (момент или отрезок: `type`, `to`); PTZ `PUT`, `DELETE /units/{uid}/ptz`, `PUT`, `DELETE /units/{uid}/presets/{n}`; `PUT /units/{uid}/recording-target` |
| `export` — выгрузка (ADR-0117) | `GET /me/export?ids=<uid,…>` — что можно человеку и по камерам; `GET /units/{uid}/recording-days` — сутки с записью для календаря (профиль `vms.camera/1`); `POST /exports/check` — проверить заказ без запуска; `POST /exports` (202) — задание: части камера × запись, ход `export.progress`, итог `export.finished`; `GET /exports`; `GET`, `DELETE /exports/{id}`; `…/cancel`, `…/retry-failed`; `POST …/files/{fileId}/link` — ссылка на файл со сроком. Камеры заказа — по `uid` (`ExportCamera.uid`), ошибки — `field` JSON Pointer по телу (`/cameras/0/area`, `/periods/1/to`); справочник — `reference.export`, необязательное — `export*` в `capabilities.features` |
| `storage` — обход и скан | `GET`, `POST /archive-watches`; `PATCH`, `DELETE /archive-watches/{id}`; `GET`, `POST /archive-scans`; `DELETE /archive-scans/{id}` |
| `operations` | `GET`, `POST /operations`; `GET /operations/{id}`; `…/pause`, `…/resume`, `…/cancel`, `…/retry-failed`, `…/revert`, `…/redo`. Шаг (`OperationItemRequest`) — `uid` и ровно одно из: `patch` (правка, как `PATCH /units/{uid}`), `folders` (папки объекта), `createUnit` (дочерний объект), `move` (+`params`: перенос к родителю), `action` (+`params`: команда вида), `delete: true`. Отказ шага — `code`, указатель — `params.field` (JSON Pointer в теле шага), слово схемы — `params.keyword` |
| `discovery` | `GET`, `POST`, `DELETE /domains/{id}/discovery` — поиск устройств в сети домена |
| `automation` — правила | `GET /rule-prompts`; `POST /rule-prompts/{id}/answer`; `GET`, `POST /rules`; `GET`, `PUT /rules/{id}`; `POST /rules/update`; `POST /rules/reorder`; `GET /rules/{id}/versions`; `GET /rules/{id}/fires`; `POST /rules/{id}/fires/{fireId}/retry`; `POST /rules/{id}/run`; `POST /rules/test` |
| `automation` — расписания, режимы | `GET`, `POST /schedules`, `GET`, `PUT`, `DELETE /schedules/{id}`; то же `/day-groups` и `/maintenance-windows`; `GET`, `PUT /modes`; `GET`, `POST /modes/current` |
| `automation` — между камерами | `GET`, `PUT /domains/{id}/scenarios`; `GET /domains/{id}/scenarios/status` |
| `access` | `GET /access` — снимок прав (`Role.kindAccess` по классам доступа); `POST /access/apply` — черновик пакетом; `POST /access/catalogs/{id}/sync`; страницами — `GET /access/users`, `/access/groups`, `/access/history`, `/access/cell-history`, `/access/roles/{id}/objects` |
| `access` — учётки потоков | `GET`, `POST /stream-accounts`; `PATCH`, `DELETE /stream-accounts/{name}`; `POST /stream-accounts/{name}/password` |
| `settings`, `journal` | `GET`, `PATCH /settings`; `GET /licenses`; `GET /journal` |
| `assist` | `POST /assist/turns` — ход разговора с ассистентом, ответ потоком (SSE); мир ассистента — `kinds` + `units`; учебные ссылки `answer.learn` — только когда глава каталога нашлась, иначе прежний разбор (`BACKEND.md`) |
| `stream` | `GET /stream` — поток событий (SSE); `PUT /stream/{clientId}/watch` — что наблюдает поток |
| `test-support` | `POST /test/reset`, `/test/clock`, `/test/events`, `/test/stream-elsewhere`; `PUT /test/kinds/{kind}` (описание вида на ходу — `kinds.changed`) — только на тестовом стенде |

Что стало действием вида (`UnitKind.actions`, `POST /units/{uid}/actions/{action}` или `POST /kinds/{kind}/actions/{action}`), а не путём: определение модели камеры и регистратора (`probe`), опрос адресов серверов (`probe` вида `server`), проверка подключения хранилища (`check`), форматирование тома (`format`), команда реле и двери (`output`), `ARM` контроллера psim и всё, что объявит новый вид. Назначение сервера в домен и исключение из него — `POST /units/{uid}/move`.

## Договорённости

- **`uid` объекта — UUID.** Ключ объекта любого вида в `/units`; в наборе он равен прежнему `id` записи старого контракта, формат не менялся.
- **Идентификаторы — UUID.** Новые записи «Оборудования», правил, хранилищ, расписаний, особых дней и окон обслуживания получают id от сервера. В наборе первая цифра UUID — вид записи: `1…` домен, `2…` сервер, `3…` устройство, `4…` папка, `5…` хранилище, `6…` том, `7…` правило, `8…` роль, `9…` пользователь, `d…` запуск правила; у видов «Автоматизации» — `f…` и номер во второй группе (`-0001-` расписание, `-0002-` особые дни, `-0003-` режим, `-0004-` окно обслуживания, `-0005-` версия правила, `-0006-` раскладка, `-0007-` монитор). Это удобно читать при отладке, но в продукте полагаться на это нельзя. У ролей, пользователей, групп, каталогов и режимов объекта id нового задаёт клиент (`crypto.randomUUID`): права и режимы уходят пакетом, и пакету нужны id до записи. Номер для показа — отдельные поля: `short` («3.3.1»), `identifier` («16»).
- **Версии записей.** У изменяемых записей есть `version` — непрозрачная строка: её сравнивают только на равенство и возвращают как есть, порядка и «+1» у неё нет (что обязан соблюдать сервер — [BACKEND.md, «Версии и 412»](BACKEND.md#на-что-обратить-внимание)). Ответ отдаёт её в `ETag` (`"v3k"`), изменение приходит с `If-Match`. Нет заголовка — `428 PRECONDITION_REQUIRED`, версия не та — `412 VERSION_MISMATCH` с актуальной записью в `current`. У прав, опций и режимов объекта версия одна на весь снимок. Течение времени (истёкшее приглушение, смена режима по расписанию) версией не считается.
- **Ошибки** — `application/problem+json`: `{code, message, field?, params?, errors?, current?}`. На путях ядра `field` — JSON Pointer в теле запроса (`/properties/mode`, `/parentId`, `/params/count`); `errors[]` необязателен, если он есть — в нём минимум одна ошибка. Исключение — `field: "/moveTo"` у `DELETE /units/{uid}`: это параметр запроса, а не тело. Интерфейс показывает свой текст по `code`; `message` — для журнала и разработчика. Перечень кодов — схема `ProblemCode`.
- **Групповые изменения.**
  - **Долгие** — `POST /operations`: план карточки, правка выборки, копирование настроек. Шаги выполняются по одному, ход приходит в поток. Частичный успех — норма: у каждого шага свой `state` и `code`. Пауза, отмена оставшегося, повтор неудачных и «Отменить» — запросы к операции; «Отменить» — новая операция, которая возвращает объекты к состоянию «до».
  - **Быстрые** — синхронные запросы с частичным успехом (`done` / `failed`): `POST /units` (группа строк с детьми), `POST /objects/delete`, `POST /rules/update`. `POST /operations` с `wait: true`, все шаги которой мгновенные (`patch`, `folders`, `move`), выполняется в самом запросе: ответ `200` — законченная операция, итог по строкам в `items`. Так пишутся состав папки, привязки и приём серверов — вместо синхронных `/folders/{id}/devices`, `/devices/update`, `/servers/assign` старого контракта. Состав папок в шагах проверяется до запуска: объекта шага нет, папка чужого домена или запись, которая в папки не входит, — отклоняется вся операция (`422`, `field` — `/items/{i}/…`, `params.targetId`).
  - **Повторы.** У всех групповых запросов есть `idempotencyKey`: повтор с тем же ключом в течение 10 минут возвращает прежний ответ и ничего не выполняет снова.
- **Страницы ограниченного прохода.** Отбор `GET /units` без члена (`q`, `kind` без `domainId`, `status`, `domainId`, `noFolder`, `noRecord`, `noDetector`) сервер проходит по разделам своего хранилища и может ответить, не дочитав домен: ответ с `nextCursor`, продолжение — с места остановки, ничего не теряется и не повторяется. **Рекомендация бэкенду: дописывай страницу до `limit` или до бюджета ~100–200 мс на запрос и только тогда отдавай курсор.** Иначе редкий поиск по большому домену — сотни запросов почти пустых страниц, и на каждую клиент отвечает волной и перерисовкой. Пустая страница с курсором при этом допустима (бюджет вышел, ничего не нашлось): клиент её выдерживает и читает дальше. `reference.limits.scanPartsMax` — сколько разделов запрос смотрит самое меньшее, если страница не набралась раньше; клиент на него не опирается. Встроенный сервер — не меньше `scanPartsMax` разделов, дальше до `limit` или до 40 мс (`SCAN_BUDGET_MS` в `server.js`: он работает в той же вкладке, и бюджет — время, когда страница не отвечает); на `large` редкий поиск — около десятка запросов вместо 512 (в настоящем времени; число зависит от машины). `stand.sparsePages: true` — встроенный сервер как бэкенд, который страницу не дописывает: ровно `scanPartsMax` разделов, пустые страницы подряд (`tests/api-pages.js`); что форма их выдерживает, проверяет `tests/scale-large.js`.
- **Поток событий** `GET /stream` (SSE). На каждое сообщение — строки `id:` и `data:` (схема `StreamMessage`), строки `event:` нет. Типы сообщений:
  - `kinds.changed` — описания видов изменились (подсказка): клиент перечитывает `GET /kinds` с `If-None-Match`; то же — после `stream.reset`;
  - `entity.created`, `entity.changed`, `entity.deleted` — с `kind` (вид объекта) и `entityId` (`uid`) (в том числе новый запуск правила — `kind: ruleFire`, смена текущего режима объекта — `kind: objectMode`);
  - `operation.progress`, `operation.finished`;
  - `discovery.progress`, `discovery.finished`;
  - `stream.reset`, `test.reset`.
  
  Клиент перечитывает запись по `id`. После обрыва браузер шлёт `Last-Event-ID`: сервер досылает пропущенное, а если оно уже потеряно — `stream.reset`, и клиент перечитывает всё.
- **Удаление с «Отменить».** Отсчёт ведёт клиент. Запрос `DELETE` (или `POST /objects/delete`) уходит, когда отсчёт закончился; «Отменить» во время отсчёта ничего не отправляет. Каскады делает сервер:
  - объект — с дочерними по `parentId` (камера — с потоками и детекторами), из папок и из записи по детекторам;
  - хранилище — с томами; камеры переходят на следующее хранилище или перестают писать;
  - домен — с переносом содержимого;
  - объект в правилах — остаётся в целях удалённым, по имени; расписание — где использовалось, переходит на «Никогда»; группа особых дней — уходит из расписаний; режим — из условий правил.
  
  В «Правах» удаление попадает в черновик, а на сервер — при «Применить».
- **Возможности системы.** Контракт один для всех систем, но система может уметь только его часть. Что она умеет, она объявляет в `GET /reference` → `capabilities` (схема `Capabilities`):
  - `operations` — `operationId` операций, которые она выполняет; остальные отвечают `404 NO_ROUTE`;
  - какие виды есть — `GET /kinds`, что система умеет с видом — `UnitKind.capabilities` (`create`, `rename`, `delete`, `enable`, `folders`, `bulkSet`…), что правится у объекта — `readOnly` в схеме вида и `Unit.writable`; создать то, чего вид не умеет, — `422 NOT_SUPPORTED`, `field: "/kind"`;
  - `features` — необязательные настройки (`serverRoles`, `serverNetwork`, `archiveEncryption`); без них поле видно в записи, но менять его нельзя — `422 NOT_SUPPORTED`.

  Интерфейс читает `capabilities` при старте и прячет неподдержанное, тесты API его пропускают, а покрытие считают по объявленному. Объявленное обязано работать по контракту целиком: «умею, но по-своему» не бывает. Что обязан бэкенд — [BACKEND.md, «Возможности системы»](BACKEND.md#возможности-системы).
- **Подписи.** Любая подпись в описании вида (`label`, `x-label`, `x-enum-labels`, `ActionDescriptor.label`…) — `Text {key, text, lang}`. Интерфейс сначала ищет `key` в своём словаре (`i18n`), и если ключа нет — показывает `text`: так новый вид приходит с готовыми подписями, а известные переводятся у интерфейса.
- **Описания видов и ETag.** `GET /kinds` отдаёт ETag — хэш описаний; `If-None-Match` с тем же тегом — `304`. Описание вида могут поменять на ходу (плагин поставили, обновили): сервер шлёт `kinds.changed`. Объект вида, описания которого нет (`GET /kinds/{kind}` — 404), читается как есть: общая иконка, код вида, правка запрещена; черновик открытой карточки не теряется.
- **Незнакомое поле — только чтение.** Интерфейс пропускает незнакомый ключ `x-*` и поле неизвестного типа или виджета показывает текстом только для чтения; значение не теряется.
- **Секреты.** Поле `writeOnly` в ответе не приходит никогда, о нём говорит `Unit.secrets[имя]: true`. Смена поля из `x-bound-to` без нового секрета — `422` с указателем на поле секрета.
- **Версия объекта и применение.** `PATCH /units/{uid}` отвечает сразу; пока система не применила правку, `status.observedVersion` отстаёт от `version` (условие `Applied`).
- **Тексты.** Сервер отдаёт коды (`role: "primary"`, `detectorKind: "motion"`, `fault: "auth"`) и числа (`sizeBytes`, `usedPercent`), подписи и переводы — в интерфейсе. Трасса запуска правила и проверка правила — тоже кодами с параметрами (`{code: "device.offline", params: {deviceId}}`). Имена объектов, тексты журнала и истории прав, шаблоны текстов в правилах — данные.
- **Время** — в UTC (ISO 8601), даты — `ГГГГ-ММ-ДД`, время суток в расписаниях — `ЧЧ:ММ` в поясе системы. Интерфейс показывает время в часовом поясе системы из `GET /me` (`timezone`); расписания и режим объекта сервер считает в нём же.
- **Пароли** только записываются: в запросе `password` (у облачного тома — `secret`), в ответе — `hasPassword` / `hasSecret`.
- **Черновики** остаются у клиента. У «Оборудования» это черновик карточки: «Применить» отправляет операцию. Если запись тем временем поменял другой администратор, нетронутые поля обновляются, а правки пользователя остаются поверх. У «Прав» черновик — весь снимок, «Применить» уходит пакетом. У «Автоматизации» — черновик правила (новое правило до «Применить» есть только у клиента) и расписания в редакторе.

## Модель данных

Две записи ядра и профили. Всё «данное» о виде приходит с сервера, код остаётся только для смысла профилей.

### `UnitKind` — описание вида (`GET /kinds`)

| Поле | Что значит |
|---|---|
| `kind` | код вида: `camera`, `archive.local`, `security_controller/CONTROLLER`, `<подсистема>/<таблица>` для строк таблиц w2c |
| `label`, `labelPlural`, `labelCount`, `icon` | подписи (`Text`) и значок; `labelCount` необязателен |
| `parents`, `createParents`, `children` | кто может быть родителем; под кем вид заводит оператор (`createParents` пуст — только вместе с новым родителем, как том с хранилищем); какие виды бывают дочерними |
| `implements` | профили вида (`vms.camera/1`…): по ним интерфейс выбирает ручной экран, сервер — хуки |
| `capabilities` | что система умеет с видом: `create`, `rename`, `delete`, `enable`, `folders`, `bulkSet`… Вид, который сервер находит сам, не создаётся и не удаляется |
| `schema` | JSON Schema свойств `Unit.properties`; расширения полей `x-*`: `x-label`, `x-enum-labels`, `x-ui-tab`, `x-ui-group`, `x-ui-order`, `x-ui-unit`, `x-ui-widget`, `x-ui-filter`, `x-search`, `x-ref {kinds, implements}`, `x-immutable`, `x-bound-to`, `x-rights`, `x-inherit`, `x-template`, `x-transient` (см. «Расширения описаний» ниже); `readOnly` — заполняет сервер, `writeOnly` — секрет |
| `schemaPerUnit`, `shape` | схема своя у каждого объекта (`GET /units/{uid}/schema`); `shape: document` — документ, а не узел дерева (общие настройки домена) |
| `access {class, levels[], also[]}`, `apiRights` | класс доступа вида и его уровни (общий набор `view < edit < admin`, если не объявлен); дополнительные классы (`tel` у камеры); права на пути предметных API. Право (`Right.class`) может назвать и класс другого вида: событие источника событий судится уровнем камер `cam`, а своего класса `cam` у источника нет — в «Правах» у него один тип доступа, как в старом макете |
| `actions[]` | `ActionDescriptor`: `id`, `label`, `execution` (`instant` — ответ сразу, `longRunning` — операция), `scope` (`unit`, `kind`), `params` и `result` (схемы), `right`, `ruleAction`, `ruleOnly`, `ruleRight` |
| `events[]` | `EventDescriptor`: `id`, `label`, `severity`, `params` (по ним — `RuleTrigger.match`), `right`, `ends` (у события есть конец), `rule` (можно брать триггером правила, по умолчанию `true`), `alarm` (попадает в «Что считать тревогой», по умолчанию `true`) |
| `setupUi {url, kinds, mode}` | страница плагина: `mode: tab` — ссылка во вкладке с параметрами `?type=&id=&lang=`; `iframe` — позже |
| `x-archive`, `x-ui-category` | расширения уровня вида: что умеет вид хранилища; где вид в мастере и срезах (см. «Расширения описаний» ниже) |

#### Расширения описаний (`x-*`)

Описание вида и схема его свойств открыты: незнакомое `x-*` клиент пропускает. Четыре расширения набора несут данные, без которых известные экраны не строятся, — их надо отдавать. Схемы — в контракте: `UnitKind.x-archive`, `UnitKind.x-ui-category`, описание `JsonSchema`.

| Расширение | Где | Что значит | Кто читает | Что без него |
|---|---|---|---|---|
| `x-archive {serverRequired, encryption, check, address, recordModes, replicaSource, serverWide, archiveModes, archiveModeDefault?, admits}` | вид хранилища (`vms.archive/1`) | что умеет вид: под сервером или на весь домен, поля тома (`address`: `disk`, `nas`, `bucket`), режимы записи камер, источник `replica`, одно на сервер, свои режимы хранилища, принимает ли записи | сервер (смысл хранилища, проверки тома и записи камеры) и интерфейс (экраны хранилищ, выбор хранилища в записи камеры) | вид хранилища не заводится и в записи камеры не предлагается; объект виден общей формой по схеме |
| `x-ui-category [{group, view, subtype?}]` | вид | группа мастера добавления (`video`, `io`, `acfa`, `integ`, `svc`), срез экрана оборудования (`cam`, `acfa`, `sys`), подвид пункта мастера (`ipsrv-nvr`) | интерфейс | вид не попадает в мастер; объекты вида видны в дереве и правятся формой по схеме |
| `x-transient` | поле схемы | значение только в запросе: сервер его судит, но не хранит и не отдаёт (`confirmShrinkBytes` тома, `configMode` и `templateId` камеры при добавлении) | сервер (проверка), интерфейс (поле формы без значения в записи) | поле хранилось бы и возвращалось как обычное |
| `x-template` | поле схемы (строка) | текст с подстановками `{…}` события правила (текст тревоги, письма) | интерфейс (предлагает подстановки) | простая строка без подсказки подстановок |

### `Unit` — объект (`GET /units`)

`uid`, `kind`, `parentId` (`null` — корень домена), `name`, `domainId`, `folders[]`, `version` (непрозрачная строка), `properties` (по схеме вида), `secrets {имя: true}`, `inherited {имя: {from: unit | domain | default}}`, `status {link, observed, observedVersion, conditions…}` (то, что система видит сама), `writable[]` (что правится у этого объекта сейчас), `capabilities`, `hasChildren` (есть дочерние объекты, которые показывает дерево: потоки и документы не считаются), `match {field}` — в ответе поиска, в каком поле нашлось. Краткий вид для узла дерева — `UnitBrief` (`uid`, `kind`, `name`, `parentId`, `domainId`, `version`, `subtype`, `status`, `brief`): `subtype` — подвид (`nvr`, `io`…) из `x-ui-category`; `brief` — свойства с `x-search` и `x-ui-filter`, `enabled`, `serverId`.

Остальные записи — как в старом контракте:

| Запись | Главное | Связи |
|---|---|---|
| `Rule`, `RuleVersion`, `RuleFire` | события → условия → шаги, запуск, «Только журнал», приглушение, порядок; версии истории; запуски с трассой | события — `{source: "unit", kinds[] \| implements[], event, match}` из `UnitKind.events`; действия — `{type: "unitAction", action, params}` из `UnitKind.actions`; цели — `{uid}` или область `{area: folder \| server \| domain, uid}`; удалённое — по имени |
| `RulePrompt` | открытый вопрос оператору: шаг `ask` или уровень `escalate`, роль, срок | `ruleId`, `fireId`, `step` |
| `Schedule`, `DayGroup`, `Modes`, `ModeCurrent`, `MaintenanceWindow` | расписания, особые дни, режимы объекта, окна обслуживания | как в старом контракте |
| `Access` | роли, пользователи, группы, каталоги, доступ учёток потоков, история | `Role.kindAccess {класс: уровень}` вместо полей категорий; `folderAccess` и `objectAccess` — карты, ключ — `uid`, значение — уровень класса объекта |
| `Settings`, `License`, `JournalEvent` | значения опций, лицензии, журнал | — |

Объекты не принадлежат серверу: они лежат в пуле домена и раскладываются по папкам. Связь с сервером — через хранилище записи (камера), расчёт детектора, службу сервера (`status.observed.serverId` или свойство вида с `x-ref` на сервер).

### Профили

Профиль публикует контракт (`GET /kinds` → `profiles`, схема `Profile`); вид объявляет `implements`. Ручной экран привязан к профилю, а не к виду; незнакомый профиль клиент пропускает. Профиль — это имена свойств (`properties`), имена наблюдаемого (`status.observed`) и предметные пути (`apis`), а тип и смысл каждого имени фиксирует сам профиль: вид, объявивший профиль, несёт свойство под тем же именем, того же типа и с тем же смыслом. **Эталон схемы вида** — `GET /kinds/{kind}` эталонного набора (`camera`, `archive.local`, `volume`…), **полный перечень стандартных профилей** со свойствами, типами и смыслом — [BACKEND.md, «Стандартные профили»](BACKEND.md#стандартные-профили). Кратко:

| Профиль | Свойства (`properties`) | Наблюдаемое (`status`) |
|---|---|---|
| `vms.domain/1` | `license` | — |
| `vms.server/1` | `allocated`, `ip`, `port`, `role`, `labels`, `netmask`, `gateway`, `dns` | `class`, `disks`, `fingerprint`, `gpu`, `telemetry` |
| `vms.folder/1` | — (состав — `Unit.folders` у членов) | — |
| `vms.camera/1` | подключение (`ip`, `port`, `login`, `password`, `vendor`, `model`, `firmware`, `mac`, `rtspUrl`, `videoChannel`), номер (`identifier`, `short`), запись (`archiveId`, `recordMode`, `extraArchives`, `retentionDays`, `minDepthDays`, `preRecordSec`, `recordScheduleId`, `replicaFrom`, `recordDetectorIds`, `audioDeviceId`), изображение (`res`, `resOptions`, `fps`, `codec`, `stream`), PTZ, `detectorOptions`, `serverId`, `enabled`, `alarmKinds`, `labels`, положение, `unitOptions` | `fault`, `faultText`, `licenseExceeded`, `recordState`, `recordReason`, `recordingTarget`, `replicaLagSec`, `armed`, `archiveJobs`, `direct`, `detectorKinds`, `disabledByRuleId`, `disabledByRuleAt` |
| `vms.archive/1` | `storage`, `recordMode`, `retentionDays`, `encrypted`, `admits`, `provider` | — |
| `vms.volume/1` | `disk`, `mode`, `dir`, `sizeBytes`, `state`, `enabled`, `file`, адрес и учётные данные сетевого и облачного | `usedPercent`, `shrinkPendingBytes`, `incidentsAtRisk`, `incidentsLost` |
| `vms.stream/1` | `streamId`, `res`, `resOptions`, `fps`, `codec`, `width`, `height` | — |
| `vms.detector/1` | `detectorKind`, `sensitivity`, `zone`, `stream`, `params`, `labels`, `alarmKinds`, `builtin`, `template`, `serverId`, `enabled` | — |
| `vms.acs/1` | подключение, `identifier`, `short`, `path`, `model`, `operations` (команды единицы), `properties` (настройки единицы СКУД — свойство с таким именем), `unitOptions`, `enabled` | `fault` |
| `vms.live/1`, `vms.timeline/1` | — | возможность предметных API: живое видео; шкала и записи |
| `vms.ptz/1`, `vms.talk/1` | `ptz`, `presets`, `presetMax`; `channel`, `enabled`, `short` | возможность предметных API: PTZ; разговор |

### Виды набора

Вид на каждый вид устройства старого контракта (`camera`, `ipsrv`, `det`, `acfa`…), плюс `domain`, `server`, `folder`, `volume`, `stream`; хранилища — вид на каждый вид хранилища (`archive.local`, `archive.network`, `archive.cloud`, `archive.backup`, `archive.edge`, `archive.incidents`): у них разные схемы адреса и режимы. Подвиды `ipsrv` — свойством. Потоки камеры — дочерние объекты вида `stream`. Незнакомые виды — для приёмки: `security_controller/CONTROLLER` и `security_controller/SENSOR` (перевод настоящего манифеста psim из `plugins/`: ссылки на камеры `x-ref`, команды, события, `setupUi`), `test.unknown` (все виды полей и виджетов `x-ui-*`), `test.perunit` (схема на объект), `w2c.example/rows` (строка таблицы с хозяином), `domain.shared` (документ общих настроек домена).

## Ломающие изменения против контракта старого макета (до 0.2.0, коммит 47d1310)

Контракт `0.2.0` несовместим с контрактом старого макета (`0.1.0`, `git show 47d1310:api/openapi.json`): ломающая правка согласована пользователем — это и есть запрос о модели. Команде, которая уже работает по старому контракту, — что снято или переименовано и чем заменено. Перечень сверяет `python3 tools/check_api.py` (старый контракт — из git по коммиту `47d1310`; без git — пропуск с пометкой `INFO`): каждая операция старого контракта, которой нет здесь, и каждая снятая или изменённая схема названы в таблицах ниже.

**Пути.** Слева — `operationId` старого контракта и путь, справа — операция этого контракта.

| Было (старый контракт) | Стало |
|---|---|
| `listDomains` `GET /domains`, `listServers` `GET /servers`, `listDevices` `GET /devices`, `listFolders` `GET /folders`, `listArchives` `GET /archives`, `listVolumes` `GET /volumes` | `listUnits` `GET /units?kind=…` или `?implements=…` (домены — `vms.domain/1`, серверы — `vms.server/1`, хранилища — `vms.archive/1`…), страницами, с прежними отборами по `uid` |
| `getDomain`, `getServer`, `getDevice`, `getFolder`, `getArchive`, `getVolume` (`GET /…/{id}`) | `getUnit` `GET /units/{uid}` |
| `createDomain` `POST /domains`, `createServer` `POST /servers`, `createDevices` `POST /devices`, `createFolder` `POST /folders`, `createArchive` `POST /archives`, `createVolume` `POST /archives/{id}/volumes`, `createStream` `POST /devices/{id}/streams` | `createUnits` `POST /units`: строки `UnitCreate` с `kind`, дочерние — `children` (хранилище с первым томом, камера с потоками); можно ли завести — `UnitKind.capabilities` (`create`) и `createParents` |
| `patchDomain`, `patchServer`, `patchDevice`, `patchFolder`, `patchArchive`, `patchVolume`, `patchStream` (`PATCH /…/{id}`, `/devices/{id}/streams/{sid}`) | `patchUnit` `PATCH /units/{uid}`: JSON Merge Patch `UnitPatch {name, folders, properties}` по схеме вида |
| `deleteDomain`, `deleteDevice`, `deleteFolder`, `deleteArchive`, `deleteVolume`, `deleteStream` (`DELETE /…/{id}`) | `deleteUnit` `DELETE /units/{uid}` (у домена — `?moveTo=`), группой — `POST /objects/delete` по `uid` |
| `updateDevices` `POST /devices/update` | `createOperation` `POST /operations`, шаги `patch`, `wait: true` — итог в ответе |
| `setFolderDevices` `POST /folders/{id}/devices` | `PATCH /units/{uid} {folders}` у объекта или шаги `folders` операции (`wait: true`; чужой домен — отказ всей операции, как раньше) |
| `assignServers` `POST /servers/assign` | `moveUnit` `POST /units/{uid}/move {parentId, params: {fingerprint}}`: родитель — домен приёма, `null` — исключить; шаг `move` (`wait: true`; сервер-камера — `createdId` камеры в итоге шага) |
| `probeServers` `POST /servers/probe`, `probeDevice` `POST /devices/probe`, `checkArchive` `POST /archives/check` | `runKindAction` `POST /kinds/{kind}/actions/{action}`: `server`/`probe`, `camera`/`probe` (и `ipsrv`), `archive.network`/`check`… |
| `formatVolume` `POST /volumes/{id}/format`, `runDeviceOperation` `POST /devices/{id}/operations/{operation}` | `runUnitAction` `POST /units/{uid}/actions/{action}`: `format`, `output`, `ARM`… (`UnitKind.actions`) |
| `startLive`, `moveLive`, `startTalk`, `getTimeline`, `getPlayback`, `listHolds`, `createHold`, `listBookmarks`, `createBookmark`, `fetchArchive`, `putPtz`, `deletePtz`, `putPreset`, `deletePreset`, `putRecordingTarget` (`/devices/{id}/…`) | те же двери под `/units/{uid}/…`: `startUnitLive`, `moveUnitLive`, `startUnitTalk`, `getUnitTimeline`, `getUnitPlayback`, `listUnitHolds`, `createUnitHold`, `listUnitBookmarks`, `createUnitBookmark`, `fetchUnitArchive`, `putUnitPtz`, `deleteUnitPtz`, `putUnitPreset`, `deleteUnitPreset`, `putUnitRecordingTarget`; доступность — профилем (`vms.live/1`, `vms.ptz/1`, `vms.talk/1`, `vms.timeline/1`, `apis`) |
| `getRecordingDays` `GET /devices/{deviceId}/recording-days` | `getUnitRecordingDays` `GET /units/{uid}/recording-days`: доступность — профилем `vms.camera/1`; не камера — `422 NOT_SUPPORTED`, `field: /kind` (в старом контракте — `field: type`) |

Новые операции ядра: `listKinds`, `getKind`, `getCreatable`, `getUnitSchema`, `validateUnits`, служебная `testPutKind` (`PUT /test/kinds/{kind}`).

**Снятые схемы.**

| Было (старый контракт) | Стало |
|---|---|
| `Domain`, `Server`, `Device`, `Folder`, `Archive`, `Volume`, `DeviceStream` | `Unit` своего вида: `domain`, `server`, `camera` и другие виды устройств, `folder`, `archive.*`, `volume`, `stream`; поля записи — `Unit.properties` по схеме вида, то, что система видит сама, — `Unit.status.observed` |
| `DeviceRow` | `Unit` в перечне `GET /units`; краткий объект узла дерева — `UnitBrief` (`TreeNode.unit`) |
| `DomainCreate`, `ServerCreate`, `DeviceCreate`, `FolderCreate`, `ArchiveCreate`, `VolumeCreate`, `StreamCreate`, `DevicesCreateRequest`, `DevicesCreateResult`, `ArchiveCreated` | `UnitCreate`, `UnitsCreateRequest`, `UnitsCreateResult` |
| `DomainPatch`, `ServerPatch`, `DevicePatch`, `FolderPatch`, `ArchivePatch`, `VolumePatch`, `StreamPatch` | `UnitPatch` |
| `DevicesUpdateRequest`, `DevicesUpdateResult` | `OperationRequest` с шагами `patch` (`OperationItemRequest`) |
| `FolderDevicesRequest` | `UnitPatch.folders`, шаг `folders` |
| `AssignRequest`, `AssignResult` | `UnitMoveRequest`, ответ — `Unit` |
| `ProbeRequest`, `ProbeResult`, `DeviceProbeRequest`, `DeviceProbeResult`, `ArchiveCheckRequest`, `ArchiveCheckResult`, `DeviceOperationArgs` | `UnitActionRequest`, `UnitActionResult`, `KindActionResult`; схемы параметров и итога — `ActionDescriptor.params`, `result` |
| `ArchiveKind` | `UnitKind.x-archive` у вида хранилища |
| `DeviceType` | `UnitKind.kind` — открытый перечень видов из `GET /kinds` |
| `ServerDisk`, `ServerTelemetry`, `Gpu` | `status.observed` сервера: `disks`, `telemetry`, `gpu` |
| `ExtraArchive`, `DevicePreset`, `DetectorOption`, `UnitOption`, `UnitProperty`, `EventWord` | свойства в схеме вида: `extraArchives`, `presets`, `detectorOptions`, `unitOptions`, `properties`, `words` |

**Изменённые схемы.** Сверены и вложенные поля (свойства, элементы массивов, перечни) общих схем старого контракта и этого, не только верхний уровень.

| Схема | Было (старый контракт) | Стало |
|---|---|---|
| `OperationItemRequest` | `targetId` и одно из `set`, `folderIds`, `create` | `uid` и одно из `patch`, `folders`, `createUnit`, `move` (+`params`), `action` (+`params`), `delete` |
| `OperationItem` | указатель отказа — имя поля | `params.field` — JSON Pointer в теле шага, `params.keyword` — слово схемы |
| `RuleTrigger` | `{source, kind, target, match}`, виды событий — `reference.ruleTriggers` | `{source: "unit", kinds \| implements, event, target, match}`, события — `UnitKind.events`; `match` — поля из `EventDescriptor.params` события (прежние перечисленные `template`, `word` сняты из схемы, ключи открыты) |
| `RuleAction` | поля действия устройства (`preset`, `minutes`, `duration`, `operation`, `state`…) | действие объекта `{type: "unitAction", action, target, params}` по `UnitKind.actions` (`ruleAction`); действие системы — `{source, action, …}` по `reference.ruleActions` |
| `RuleTestRequest` | `events[]`: `{source, kind, match, deviceId}`, `source` — подраздел триггера (`vms`, `det`, `rec`), `kind` — код события | `events[]`: `{source: "unit", event, match, deviceId}` — код события из `UnitKind.events`; старое тело с `kind` — `422` |
| `RuleFire` | `events[]`: `{source, kind, match, deviceId, at}` | `events[]`: `{source: "unit", event, match, deviceId, at}` — как у `RuleTestRequest` |
| `RuleTarget` | `include: [{kind: device \| folder \| server \| domain, id}]` | `include: [{uid}]` — объект, `[{area: folder \| server \| domain, uid}]` — область |
| `RoleGlobal` | уровни категорий `dCam`, `dTel`, `dArch`, `dAcfa`, `dMic`, `dSpk`, `dSens`, `dRelay`, `dPos`, `dMacro`, `dPlug`, `dVw` | сняты: `Role.kindAccess {класс: уровень}` и `RoleRow.kindAccess` по классам доступа (`UnitKind.access`) |
| `Reference` | `deviceKinds`, `deviceParams`, `ipServerSubtypes`, `detectorKinds`, `archiveKinds`, `storageTypes`, `volumeStates`, `eventKinds`, `ruleTriggers` | сняты: всё это — описания видов `GET /kinds` (виды, схемы с `x-enum-labels`, `x-archive`, `x-ui-category`, `events`) |
| `Capabilities` | `deviceTypes`, `foundDeviceTypes`, `unitTypes`, `writableFields` | сняты: `GET /kinds`, `UnitKind.capabilities`, `readOnly` в схеме вида, `Unit.writable`; остались `operations`, `features` |
| `TreeNode` | `row` | `unit` (`UnitBrief`), плюс `icon`, `implements`; `kind` — код вида |
| `TreePathStep` | `kind` — перечень `domain`, `folder`, `server`, `device`, `archive`, `volume`, `unalloc` | `kind` — код вида объекта, открытая строка |
| `AssistWorld` | `devices`, `folders`, `servers` | `kinds`, `units` |
| `AssistPlanItem` | `deviceId`, `set` | `uid`, `patch` |
| `AssistFoundFilter` | `type` | `kinds`, `implements`, `fields` (фильтры `GET /units`) |
| `AssistEvent` | — | `action`: команда вида над отобранным в `found` |
| `StreamMessage` | `kind` — перечень видов записей (`device`, `server`, `archive`…); задание выгрузки — `export` | `kind` — вид объекта (`camera`, `archive.local`…) или вид записи вне склада (`rule`, `operation`…); задание выгрузки — `exportJob`: код `export` занят видом объекта «Агент экспорта»; новый тип `kinds.changed` |
| `ExportCamera`, `ExportPart`, `ExportFile`, `ExportCheck` (`files[]`), `ExportGrant` (`devices[]`) | камера — `deviceId` | камера — `uid` объекта (вид с профилем `vms.camera/1`); `GET /me/export?ids=` — `uid`. Не камера — `422 NOT_SUPPORTED`, `params.profile`, нет объекта — `404`, `field: /cameras/i` |
| `ExportCreate`, `AssistExport` (план выгрузки ассистента, `AssistEvent.export`) | камера — `deviceId`, `highlight.detectorIds` — `uuid` | камера — `uid` (`ExportCamera`), `uid` детекторов; ошибки тела по схеме — `field` JSON Pointer (`/cameras/0/uid`), как у путей ядра |
| `BookmarkCreate` | отказ конца отрезка — `field: to` | `field: /to` — указатель, как у прочих предметных путей |
| `Problem` | — | `errors[]` — все ошибки проверки, `field` на путях ядра — JSON Pointer в теле |
| `TestEventRequest` | `type` — перечень событий стенда; `found.type` — `DeviceType` | `type` и `unit.event` с `eventId`, `match` — событие объекта по описанию его вида; `found.type` — код вида, открытая строка |
| `Profile`, `UnitKind` и другие новые | — | ядро модели, см. «Модель данных» |


## Эталонный набор

`fixtures/demo.json` — данные основного макета в виде ответов API: разделы `kinds` (описания видов), `profiles` и `units` вместо `domains`, `servers`, `devices`, `folders`, `archives`, `volumes`; остальные разделы (правила, расписания, права, опции, журнал, справочники) — как в ответах API, ссылки на объекты в них — по `uid`. `uid` равен прежнему `id` записи старого макета. Набор правится руками: описания видов (включая `security_controller/*` по манифесту из `plugins/` и синтетические `test.*`) и объекты; после правки — `python3 tools/profile_fixture.py` и `python3 tools/build_api.py`. Демо-запуски правил посчитаны тем же движком, что у встроенного сервера (`tools/fixture_fires.js`). Сдвиг дат и остальные поля:

- `capturedAt` — момент снимка. При загрузке каждая дата и каждый момент сдвигаются на «сейчас − `capturedAt`», даты — на целые сутки. Так «вошёл вчера» и «истекает через неделю» остаются правдой в любой день. Календарь — расписания и особые дни — не сдвигается: праздник остаётся праздником.
- `modeManual` — режим объекта, включённый вручную (`null` — по расписаниям).
- `network` — что «видно» в сети каждого домена: это находит поиск. `discovery` — итог последнего поиска.
- `me` — администратор, от имени которого работает стенд.
- `reference.capabilities` — что умеет система с этим набором: в `demo.json` — весь контракт.

### Набор профиля one-domain

`fixtures/one-domain.json` — система, которая умеет часть контракта. Так выглядит VMS с одним доменом на установку, камерами и детекторами, хранилищами из одного тома без шифрования, правилами и пользователями. Набор собирает `tools/profile_fixture.py` из `demo.json`: берёт первый домен, его серверы, камеры с детекторами, папки, хранилища (первый том, без шифрования), правила, у которых после этого остались события и действия (из целей уходит то, чего в профиле нет), всех пользователей. Чего в профиле нет:

| Нет | Как это выглядит в API |
|---|---|
| второго домена | у вида `domain` нет `create` и `delete` в `UnitKind.capabilities`, `createParents` пуст |
| видов, кроме камер и детекторов, плагинов и тестовых видов | в `GET /kinds` их нет; тесты с `needs: kind:…` пропускаются. Исключение — виды, чьи события и действия предлагает редактор правил (`ruleActions` профиля): датчик (`io.input`), источник событий (`text`), СКУД и её единицы (`unit`), реле (`output`). Их описания в `GET /kinds` есть — каталог правил собирается из них, — но объектов нет и завести их нельзя: без `create`, `createParents` пуст, без `x-ui-category` (`RULE_ONLY_KINDS`). Тесту объектов такой вид не годится: `needs: kind:…` требует, чтобы вид заводился или его объекты были в наборе |
| лицензий | нет `listLicenses` |
| поиска в сети | нет `getDiscovery`, `startDiscovery`, `stopDiscovery` |
| томов сверх первого | у вида `volume` нет `create` и `delete`; первый том заводится строкой нового хранилища (`children`), под существующим — `422 NOT_SUPPORTED`. Класса доступа `tel` у камеры нет |
| ролей и сетевых настроек серверов, шифрования | `features: []` |

Набор не правят руками: правят `demo.json` или правила в `tools/profile_fixture.py` (отбор по видам и профилям, `KIND_MISSING`, `PLUGIN_KINDS`, `RULE_ONLY_KINDS`, `MISSING`) и собирают заново: `python3 tools/profile_fixture.py`. Макет с этим набором — `index.html?fixture=one-domain`. Набор `large.json` — тот же профиль без записей оборудования, в `stand.large` только числа (250 000 камер, 500 серверов): записи считает заглушка при загрузке (`expandLarge` в `server.js`). В отличие от `one-domain`, у `large` и `xl` есть ассистент (`assistTurn`, функция `assist`): стенд меряет поиск вместе с ним. Набор `xl` — тот же `large` с другими числами (1 000 000 камер, 2 000 серверов, 1 200 папок): в `fixtures/xl.json` только наложение — `"$base": "large"` и `stand`, в `fixture.js` он собран `Object.assign` поверх `large`, а не второй копией (`tools/build_api.py`, `tools/serve_api.mjs`). Макет — `index.html?fixture=xl`.

Числа `stand.large` — на весь набор: `cameras`, `servers`, `folders`, `serverCameras` (камеры под серверами), `clusters`, `relayed` (кластеры за ретранслятором); `firstBranch` — ветка первого сервера, она своя в каждом домене. Необязательные `domains` (доменов, по умолчанию 1) и `domainNames` (имена по порядку, иначе «Домен N») делят набор на домены: `expandLarge` раскладывает всё поровну блоками по порядку. Домены сверх первого — копии первого домена набора (те же свойства и доступ; роли стенда на домены не завязаны). У каждого домена свои серверы с хранилищами и томами, свои кластеры, папки в корне домена и камеры: камера сервера — в домене сервера, камеры без сервера — поровну, камера в папке — только в папке своего домена. Ретранслятор — у первого домена, за ним его доля `relayed`. Номера — сквозные: uid, имена серверов («Кластер N/Сервер NNN»), папок и камер не повторяются в наборе, а при `domains: 1` раскладка та же, что у `large`. У `xl` — `domains: 4`: Москва, Санкт-Петербург, Казань, Новосибирск; каждый — как `large`: 250 000 камер, 500 серверов в 40 кластерах, 300 папок, 50 000 камер под серверами, ветка первого сервера — 1 000 камер, ретранслятор (5 кластеров) — у Москвы. Домены `xl` заводит стенд из чисел при загрузке; завести или удалить домен профиль по-прежнему не даёт: у вида `domain` нет `create` и `delete`.

## Тестовый стенд

Служебные операции (тег `test-support`) есть только у встроенного сервера на странице тестов и у тестового стенда бэкенда:

- `POST /test/reset` — загрузить набор по имени (`fixture`: `demo`, `one-domain`, `large` или `xl`; `fixturePatch` — изменения на прогон в формате JSON Merge Patch, `actAs` — от имени другого логина), остановить часы (`freezeClock: false` — пусть идут);
- `POST /test/clock` — сдвинуть часы на `advanceSec` и выполнить всё, что за это время наступило: шаги операций, форматирование, поиск в сети, синхронизацию каталогов;
- `POST /test/events` — событие извне: устройство потеряло или вернуло связь, сменилась причина; событие объекта по описанию его вида (`unit.event`);
- `PUT /test/kinds/{kind}` — добавить или заменить описание вида на ходу: `kinds.changed`, новый ETag `/kinds`;
- `POST /test/stream-elsewhere` — открытые потоки ушли на другой экземпляр: `PUT /stream/{clientId}/watch` на них отвечает `404`.

## Проверки

Подробно — что проверяет каждая, когда запускать, как устроена самопроверка `?selftest`: [TESTS.md](TESTS.md).

| Команда | Что проверяет |
|---|---|
| `python3 tools/check_api.py [--lint]` | контракт и `redocly lint`; оба набора — по схемам и целостности ссылок, их возможности — по контракту, данные набора — не противоречат объявленному; `one-domain.json` собран из нынешнего `demo.json`; сборку `openapi.js` и `fixture.js`; что в HTML прототипа нет данных сервера и интерфейс не трогает внутренности сервера; досылку потока; что сервер и контракт совпадают по операциям; числа в `BACKEND.md`; «Ломающие изменения» против старого контракта |
| `python3 tools/run_api_tests.py [--fixture one-domain] [--clock real]` | тесты API `tests/api.html` (двойной клик — то же): сценарии по разделам, каждый ответ — по схеме, покрытие объявленных операций; с набором профиля и на часах, которые идут по-настоящему |
| `python3 tools/check_loopback.py` | те же тесты по HTTP и SSE через Service Worker (`tests/loopback-sw.js`) |
| `python3 tools/check_ui.py [--latency 300]` | сценарии интерфейса `tests/ui-*.js` (в том числе `ui-unknown.js` — незнакомый вид): действия пользователя → запросы → экран и сервер; `ui-profile.js` — на наборе one-domain: неподдержанное спрятано |
| `python3 tools/check_ui.py --selftest` | самопроверку прототипа `?selftest`: те же сценарии изнутри страницы |
| `python3 tools/check_stand.py [адрес] [--fixture one-domain] [--clock real]` | внешний режим целиком: тесты API и прототип `?selftest` открываются с диска и работают со стендом по HTTP — с образцом `tools/serve_api.mjs` или со стендом бэкенда по адресу |
| `python3 tools/compare_screens.py --page index_NN_….html --against index.html` | внешний вид прототипа против основного макета: те же экраны, разметка по разметке (оба над `api/`) |

Прототип проверяют теми же командами с `--page index_NN_….html`.

`tests/api.html?api=https://адрес` — те же тесты API против стенда бэкенда (см. `BACKEND.md`); `&fixture=one-domain` — с набором профиля, `&clock=real` — без остановки часов. `node tools/serve_api.mjs` — образец тестового стенда: встроенный сервер за HTTP, с CORS и SSE, как их ждёт клиент.
