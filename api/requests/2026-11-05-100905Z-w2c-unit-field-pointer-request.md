# Запрос от команды w2c: `field` отказа на путях `/units/{uid}/…` — везде JSON Pointer

2026-11-05 · контракт 0.2.0, коммит `11f0620` (`api/openapi.json` и `api/server.js` не менялись до `90acc78`) · от команды w2c (бэкенд VMS)

**Статус: отвечен · [ответ от 2026-11-09](2026-11-05-100905Z-w2c-unit-field-pointer-response.md)**

Общее правило в контракте уже записано. У `Problem.field` сказано: «На путях ядра (/units…) — всегда JSON Pointer в теле запроса». Описания путей `/units/{uid}/…` его повторяют: «field отказа — JSON Pointer: в теле запроса (/streamId), свойство объекта — /properties/<имя>». Так же написаны `/kind` у всех путей, `/params/…` у `runUnitAction`, `/from` и `/to` у `getUnitRecordingDays`, `/to` у `BookmarkCreate`.

Но в шести описаниях операций `field` стоит без указателя, просто именем поля старого пути. Встроенный сервер на этих путях уже отвечает указателем: имя поля переводит `subject()` (`api/server.js:3352–3364`, таблица `SUBJECT_POINTER`). Расходится только текст контракта. Мы пишем бэкенд по описаниям, и по ним нельзя понять, что придёт клиенту: `streamId` или `/streamId`.

## Что просим

1. **Поправить шесть описаний.** Значение `field` — то, что уже отдаёт встроенный сервер.

| Операция | Строка `openapi.json` | Сейчас | Нужно | Почему |
|---|---|---|---|---|
| `startUnitLive` | 5462 | «чужой streamId — 422 VALIDATION_FAILED, field: streamId» | `/streamId` | поле тела `LiveRequest` |
| `createUnitHold` | 5838 | «Конец не позже начала — 422 VALIDATION_FAILED, field: to» | `/to` | поле тела `HoldCreate` |
| `fetchUnitArchive` | 6056 | «Конец не позже начала — 422, field: to» | `/to` | поле тела `ArchiveFetchRequest` |
| `createUnitBookmark` | 5995 | «Пустая заметка — 422 VALIDATION_FAILED, field: note» | `/note` | поле тела `BookmarkCreate` |
| `startUnitTalk` | 5575 | «не spk — 422 NOT_SUPPORTED, field: type» | `/kind` | тела у операции нет. «Не динамик» — это вид объекта без `vms.talk/1`, и такой отказ уже описан в начале той же операции: `field /kind`. Сервер переводит `type` → `/kind` |
| `putUnitPreset` | 6208 | «камера без ptz — 422 NOT_SUPPORTED, field: ptz» | `/properties/ptz` | PTZ — свойство камеры, а не поле тела `PresetWrite`. По правилу «свойство объекта — /properties/<имя>», сервер переводит `ptz` → `/properties/ptz` |

Номера строк — строка `operationId` операции.

2. **Проверка, чтобы так не повторилось.** Если `tools/check_api.py` проверяет описания, просим добавить правило: в описаниях путей ядра (`/kinds…`, `/units…`) после `field` стоит значение с `/`. Если проверка описаний туда не ложится, просим хотя бы строку в `api/README.md`: на путях ядра `field` пишется только указателем.

На старых путях `field` по-прежнему имя поля, как сказано у `Problem.field`. Этот запрос их не касается.
