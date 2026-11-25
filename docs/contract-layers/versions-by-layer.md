# Версии контракта по слоям

Таблица говорит, кому из бэкендов делать каждую версию контракта с 0.3.0 по текущую. Слой версии — это слой её схем и путей в `api/openapi.json` (расширение `x-layer`, [«Слои контракта» в `api/README.md`](../../api/README.md)).

## Как читать

- **Столбец «Слой» отвечает на вопрос: кому делать версию.** Механизм делает каждый бэкенд. Профиль делает тот бэкенд, который его объявил. Так w2c переходит с 0.2.0 сразу на механизм: он делает строки «механизм» и строки тех профилей, которые объявит.
- **`video`** — просмотр, архив, выгрузка. Их заберёт будущий API видео.
- **`vms`** — часть VMS без своего профиля. Часть 04 переделки по слоям вынесла из механизма пути домена и справочники VMS (0.32.0); остальное — поля в `KNOWN_LEAKS` (`tools/layers.py`).
- **«механизм; `профиль`»** — смешанная версия. Что из неё механизм, а что профиль, написано в столбце «Что».
- Столбец «Слой» содержит «механизм» или значения `x-layer` в обратных кавычках, через `; `. Пояснения пишут только в столбце «Что».

| Версия | Что | Слой | Схемы и пути `openapi.json` |
|---|---|---|---|
| 0.3.0 | Цепочка правила: «или», шаги, интервал. Механизм: правила. `vms`: события и команды видов камеры, реле, сервера и тома — это данные набора | механизм; `vms` | `Rule*`, `RuleAbort`, `RuleAfter`, `RuleCheck`, `Reference.ruleFeatures`, `ruleControls`; события и команды видов — данные набора |
| 0.4.0 | Режимы | механизм | `ObjectMode`, `Modes*`, `ModeCurrent*`, `RuleCondition`, `RuleStatus` |
| 0.5.0 | Карточка кассы | `vms.pos/1` | `PosRawLine`, `PosRawLines`, `/units/{uid}/pos/raw` |
| 0.6.0 | Репликация со встроенного хранилища. `vms.edge/1`: репликация. `vms.timeline/1`: забор архива (`edgeOnly`). `UnitStatus` и `StreamMessage` — общие схемы | `vms.edge/1`; `vms.timeline/1` | `EdgeReplication*`, `UnitStatus`, `StreamMessage`, `ArchiveFetch*` (`edgeOnly`) |
| 0.7.0 | Предзапись у каждого хранилища камеры | `vms.camera/1` | данные вида (`preRecordSec`) |
| 0.8.0 | Поиск в журнале | механизм | `Journal*`, `/journal/facets`, `/journal/kinds`, `Feature` |
| 0.9.0 | Журнал аудита и выгрузка CSV | механизм | `/journal/export`, `Feature.journalAudit`, `JournalEvent` |
| 0.10.0 | Умолчания и настройки с устройства у камеры | `vms.camera/1` | команды вида `defaults`, `readConfig` |
| 0.11.0 | Веб-сервер и RTSP-сервер. Механизм: поле `ActionDescriptor.direct`. Остальное — профиль | `vms.webserver/1`; механизм | `WebServerSettings`, `WebCertificate`, `WebReservedPorts`, `UnitStatus`, коды `PORT_TAKEN`, `CERTIFICATE_*`, `KEY_MISMATCH`; механизм — `ActionDescriptor.direct` |
| 0.12.0 | Настройки детектора и поддетекторы | `vms.detector/1`; `vms.subdetector/1` | данные видов `det`, `subdet` |
| 0.13.0 | Маска и треки детектора | `vms.detector/1` | данные вида `det` |
| 0.14.0 | Автор у каждой записи журнала. Ломающая правка | механизм | `JournalEvent.actor` обязательно |
| 0.15.0 | Поля детекторов и зон по отчёту Axxon One | `vms.detector/1`; `vms.subdetector/1` | данные видов `det`, `subdet` |
| 0.16.0 | Страница плагина, `x-hidden`, `statusSchema`, кэш `/kinds`. Есть ломающая правка | механизм | `SetupUiLink`, `/units/{uid}/setup-ui`, `UnitKind`, `Unit`, `UnitCondition`, `JsonSchema`, `Text`, `/kinds` |
| 0.17.0 | Маска приватности камеры, мета-детектор, детекторы лиц, события детекторов в правилах. `EventDescriptor` — только описание | `vms.camera/1`; `vms.detector/1` | данные видов; `EventDescriptor` — описание |
| 0.18.0 | Один детектор в событии правила (`match.detector`). Движок правил знает `vms.detector/1`: это вынесет часть 04 | `vms.detector/1` | `params.detector` событий камеры |
| 0.19.0 | Общая загрузка файлов, файлы хода ассистента, пределы файлов | механизм | `FileUpload`, `/files`, `AssistTurnRequest.fileIds`, `Reference.limits` |
| 0.20.0 | Ключи лицензий. Есть ломающая правка | механизм | `LicenseKey*`, `/licenses/keys…`, `License` |
| 0.21.0 | Несовместимые виды серверных детекторов на одном сервере | `vms.detector/1` | `Reference.analyticsConflicts`, `ProblemCode` |
| 0.22.0 | `params.with` в `409 BUSY`. Ломающая правка | `vms.detector/1` | `params.with` в `409 BUSY` |
| 0.23.0 | Проверка `match.detector` при сохранении правила. Ломающая правка: новый отказ на прежнем запросе | `vms.detector/1` | `RuleTrigger.match.detector` |
| 0.24.0 | Слои контракта: расширение `x-layer` у схем, путей и полей подсистем | механизм | `x-layer` |
| 0.25.0 | Профили в файлах: `version` и `uses` у `Profile` | механизм | `Profile.version`, `Profile.uses`, `ProfileUse`, `api/profiles/` |
| 0.26.0 | Раскладки дерева объявляет система: `GET /kinds` → `layouts`. Ломающая правка: у `layout` снят `enum` | механизм | `TreeLayout`, `PlaceRule`, `KindSelector`, `TreeGroup`, `KindsList.layouts`, `TreeNode.group`, `StreamMessage.layout`, параметр `layout` у `/tree/children` и `/tree/paths` |
| 0.27.0 | Разделы приложения объявляет система: `capabilities.sections` | механизм | `AppSection`, `Capabilities.sections` |
| 0.28.0 | Область системы и папка — профили механизма; `vms.domain/1`, `vms.folder/1` устарели. Ломающая правка: тест механизма требует `core.domain/1` | механизм; `core.domain/1`; `core.folder/1` | `api/profiles/core.domain.json`, `api/profiles/core.folder.json`, описания `Unit.domainId`, `UnitBrief.domainId` |
| 0.29.0 | Поиск в сети, сценарии между камерами и ретрансляторы — пути профилей `/units/{uid}/…`; пути `/domains/{domainId}/…` устарели. Есть ломающая правка: `operationId` перешли на новые пути | `vms.discovery/1`; `vms.scenarios/1`; `vms.relays/1`; `vms` | `/units/{uid}/discovery`, `/units/{uid}/scenarios…`, `/units/{uid}/relays…`, `Discovery*`, `Scenario*`, `Relay*`, `api/profiles/vms.discovery.json`, `vms.scenarios.json`, `vms.relays.json` |
| 0.30.0 | Справочники VMS — в описания видов и ответы путей своих слоёв; ключи `Reference` устарели и вышли из `required` (для клиента — ломающая правка). Механизм — `examples` в подмножестве схемы вида и устаревшие ключи `Reference` | механизм; `vms.detector/1`; `vms.scenarios/1`; `vms.discovery/1`; `video` | `/exports/reference`, `ScenarioDoc.kinds`, `ScenarioDoc.maxItems`, `Discovery.ipScanMax`, `Reference.*` (deprecated), `JsonSchema`, `api/profiles/vms.detector.json` |
| 0.31.0 | Каталог правил без VMS: значения полей действий — `schema` поля, проверки шага `check` — `Reference.ruleChecks`, что в области цели — раскладка `Reference.ruleTargets.areaLayouts`; `Reference.layouts` и `monitors` устарели и вышли из `required` (для клиента — ломающая правка). Механизм — каталог и движок правил; `vms.camera/1` — условия `armed`, `recording` и проверки `record`, `safe`, `armed` (хуки профиля, данные набора) | механизм; `vms.camera/1` | `RuleActionField`, `Reference.ruleChecks`, `Reference.ruleTargets.areaLayouts`, `Reference.layouts`, `Reference.monitors` (deprecated), описания `RuleCondition.kind`, `RuleCheck.what`, `RuleTarget.include` |
| 0.32.0 | Механизм без VMS (ломающая версия). Сняты пути `/domains/{domainId}/…`, справочники VMS в `Reference` и `Reference.limits`, `RuleActionField.options`, профили `vms.domain/1` и `vms.folder/1`. Обязательны `KindsList.layouts`, `Capabilities.sections`, `Reference.ruleChecks`, а у путей профилей — `Discovery.ipScanMax`, `ScenarioDoc.kinds`, `ScenarioDoc.maxItems`. Коды `RuleCondition.kind`, `RuleCheck.what`, `RuleTarget.include[].area`, `Reference.ruleTargets.areas` — открытые строки. Механизм — всё, кроме обязательных полей путей профилей | механизм; `vms.discovery/1`; `vms.scenarios/1` | `/domains/{domainId}/…` (сняты), `Reference`, `RuleActionField`, `KindsList`, `Capabilities`, `RuleCondition`, `RuleCheck`, `RuleTarget`, `Discovery`, `ScenarioDoc`, `/exports/reference`, `/units/{uid}/scenarios`; `api/profiles/vms.domain.json`, `api/profiles/vms.folder.json` (сняты) |
| 0.33.0 | Своя страница подсистемы, шаг 1: `mode: iframe` по праву `view`, `protocol`, `origin`, `SetupUiLink.readOnly`; протокол `setup/1` и библиотека — файлы рядом с контрактом. Стенд — вид `security_controller/KEYPAD` с относительным адресом тестовой страницы | механизм | `UnitKind`, `SetupUiLink`, `Unit`, `/units/{uid}/setup-ui` |
| 0.34.0 | Своя страница подсистемы, шаг 2: разметка `x-bridge` — что страница вызывает через consolem (`read` 28, `act` 6, `draft` 6, остальные 98 мост закрывает). Механизм — расширение `x-bridge` и разметка путей механизма; у путей профилей `vms.discovery/1`, `vms.scenarios/1`, `vms.relays/1`, `vms.pos/1` — только пометка `x-bridge` | механизм; `vms.discovery/1`; `vms.scenarios/1`; `vms.relays/1`; `vms.pos/1` | `x-bridge` у операций, описание `UnitKind.setupUi` |
| 0.35.0 | Мост своей страницы сужен: команда вне своего объекта и команда вида — с вопросом consolem, журнал — только свой объект без аудита, отмена — только своих операций, скрытая страница только читает. Ломающая правка: новые отказы на прежних вызовах моста. Профиль `vms.camera/1` — схема `AreaStateSummary` (итог круга камер области); механизм — описания `Feature`, устаревшие операции необязательны | механизм; `vms.camera/1` | поведение моста (`x-bridge` без изменений), `AreaStateSummary`, `Feature` |
| 0.36.0 | Поиск в сети: сервер и категория оборудования в необязательном теле `startDiscovery`; профиль `vms.discovery/1` 1.1. Механизм — только поведение встроенного сервера | `vms.discovery/1`; механизм | `DiscoveryStart`, `Discovery.serverId`, `Discovery.category`, `DiscoveryCandidate.category`, `DiscoveryCandidate.serverId` |
| 0.37.0 | Пресет PTZ: записано ли положение и какое; диафрагма в аренде движения; профили `vms.ptz/1` 1.2 и `vms.camera/1` 1.7 | `vms.ptz/1`; `vms.camera/1` | `PtzMove.iris`; свойство профиля `presets[]`: `savedOnDevice`, `pan`, `tilt`, `zoom` |
| 0.38.0 | Правила имени объекта в описании вида: `UnitKind.nameSchema` (`minLength`, `maxLength`, `pattern`); у домена набора — до 100 знаков. Клиент проверяет имя сам, сервер правила пока не судит | механизм | `UnitKind.nameSchema` |

## Как дополнять

- Каждая новая версия контракта получает строку в этой таблице. Строку пишет тот, кто поднимает версию, в том же коммите.
- Строку сверяют с `git show --stat` коммита версии. Коммиты версий находит `git log -G'"version": "0\.[0-9]+\.0"' -- api/openapi.json`.
- Если версия правит и механизм, и профиль, в столбце «Слой» стоят оба слоя, а в столбце «Что» написано, что из них механизм.
- После части 02 правка только профиля версию контракта не поднимает, и в эту таблицу она не попадает. Её история — поле `changes` в файле профиля.
- Версию поднимает правка `api/openapi.json`. Правка только файлов сервера (`server.js`…) версию не поднимает и в таблицу не попадает (решение владельца 2026-11-18).
- `python3 tools/check_api.py` проверяет таблицу: у каждой версии из `api/README.md` и у текущей есть строка, а слои знакомые.
