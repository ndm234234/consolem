<!-- Собрано tools/build_api.py из api/profiles/vms.volume.json — руками не править -->
# `vms.volume/1` — Том

Версия 1.1 · ведёт: mockup · смотрят правку: w2c

Использует: `vms.archive/1` с 1.0, `vms.server/1` с 1.0

Виды эталонного набора: `volume`.

## Свойства

| Свойство | Тип | Смысл | С версии |
|---|---|---|---|
| `account` | string | «Учётная запись» | 1.0 |
| `bucket` | string | «Корзина» | 1.0 |
| `confirmShrinkBytes` | integer | Второе подтверждение уменьшения: равно новому sizeBytes. Меньшая квота без него — 422 VALIDATION_FAILED, field: sizeBytes. Не хранится (не хранится) | 1.0 |
| `dir` | string | «Папка» | 1.0 |
| `disk` | string | «Диск» | 1.0 |
| `enabled` | boolean | «Включено»: false — том выключен, состояние off. Поля нет — включён | 1.0 |
| `endpoint` | string | «Адрес» | 1.0 |
| `file` | string | «Файл» | 1.0 |
| `host` | string | «Сервер» | 1.0 |
| `keyId` | string | «Ключ доступа» | 1.0 |
| `login` | string | «Имя пользователя»: Учётная запись NAS | 1.0 |
| `mode` | string: `part`, `file`, `dir` | «Режим» | 1.0 |
| `password` | string (секрет) | «Пароль» (секрет (`writeOnly`)) | 1.0 |
| `path` | string | «Путь» | 1.0 |
| `port` | integer | «Порт» | 1.0 |
| `proto` | string: `http`, `https` | «Протокол» | 1.0 |
| `region` | string | «Регион» | 1.0 |
| `secret` | string (секрет) | «Секретный ключ» (секрет (`writeOnly`)) | 1.0 |
| `sizeBytes` | integer | «Объём» | 1.0 |
| `state` | string: `ready`, `format`, `open`, `off`, `maint`, `broken`, `unfmt`, `error` (только чтение) | «Состояние» (только чтение) | 1.0 |
| `style` | string: `path`, `vhost` | «Вид адреса» | 1.0 |

## Состояние (`status.observed`)

| Свойство | Тип | Смысл | С версии |
|---|---|---|---|
| `incidentsAtRisk` | массив string | том `incidents`: метки удержаний под угрозой перезаписи | 1.0 |
| `incidentsLost` | object | том `incidents`: удержанное и потом перезаписанное кольцом | 1.0 |
| `shrinkPendingBytes` | integer | объявленная меньшая квота, которую ещё не подтвердили (`confirmShrinkBytes`) | 1.0 |
| `usedPercent` | integer | заполненность тома, % Нет значения — у сервера нет такой возможности: особый экран поле не показывает (`absent`). | 1.0 |

## Изменения

| Версия | Что |
|---|---|
| 1.1 | Запрос 154325Z, ответ w2c, п. 3 и 3.1: `absent: unsupported` у полей, которых у w2c нет: usedPercent. Нет значения — у сервера нет такой возможности: особый экран прячет поле, если его нельзя править. Поля и типы не менялись |
| 1.0 | Профиль перенесён в файл из api/fixtures/demo.json и api/BACKEND.md, контракт 0.25.0. Поля до переноса — с 1.0; когда какое поле появилось в контракте — api/README.md, «Что добавлено в …» |
