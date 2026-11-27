<!-- Собрано tools/build_api.py из api/profiles/vms.subdetector.json — руками не править -->
# `vms.subdetector/1` — Поддетектор

Версия 1.3 · ведёт: mockup · смотрят правку: w2c

Использует: —

Виды эталонного набора: `subdet`.

## Свойства

| Свойство | Тип | Смысл | С версии |
|---|---|---|---|
| `classes` | массив string: `person`, `car`, `bike`, до 8 | Как у детектора. Нет поля — все классы | 1.0 |
| `confirmFrames` | integer | «Кадров подряд»: С 0.15.0. multi: столько кадров подряд число объектов должно держаться, чтобы поддетектор сработал. Нет поля — 1 | 1.0 |
| `cooldownSec` | integer | «Пауза между событиями»: С 0.15.0. multi: не чаще одного события за столько секунд. Нет поля — 1 | 1.0 |
| `direction` | string: `ab`, `ba`, `both` | Для `line` и `stripe`, нет поля — `both`. С 0.15.0 и для `a2a`: `ab` — из `zone` в `zoneTo`, `ba` — обратно, `both` — в обе стороны; нет поля — `ab` | 1.0 |
| `enabled` | boolean | Нет поля — включён | 1.0 |
| `extraZones` | массив object, до 16 | С 0.15.0. `in` — ещё области (несколько областей подсчёта у `multi`), `ex` — свои исключения вдобавок к исключениям детектора | 1.0 |
| `group` | object | Нет поля — без группы | 1.0 |
| `lostObjectType` | string: `left`, `taken`, `any` | С 0.15.0. `abandoned`: оставленный, унесённый или любой предмет. Нет поля — `left` | 1.0 |
| `maxObjects` | integer | «Объектов не больше»: С 0.15.0. multi: конец диапазона числа объектов. Меньше minObjects — 422 VALIDATION_FAILED, field: /properties/minObjects, params.reason: minAboveMax. Нет поля — без верхней границы, как раньше | 1.0 |
| `minObjects` | integer | `multi` | 1.0 |
| `objectSize` | object | С 0.15.0. Свой размер объекта; `min` выше `max` — `reason: "minAboveMax"`. Нет поля — размер детектора | 1.0 |
| `offset` | object | Смещение, % рамки объекта | 1.0 |
| `rangeMode` | string: `in`, `out` | «Тревога, когда число»: С 0.15.0. multi: поддетектор срабатывает, когда число объектов в диапазоне minObjects–maxObjects или вне его. Нет поля — in, как раньше | 1.0 |
| `showLine` | boolean | С 0.15.0. `line`, `stripe`: клиент рисует линию. Нет поля — `true` | 1.0 |
| `speed` | object | `move`. Единица условная, с Axxon One не сверялась | 1.0 |
| `subdetectorKind` | string: `line`, `enter`, `exit`, `dwell`, `stop`, `move`, `multi`, `a2a`, `abandoned`, `mask`, `stripe` | Вид поддетектора (не меняется после создания). Незнакомое значение клиент показывает кодом, только чтение | 1.0 |
| `timeMode` | string: `gt`, `lt`, `eq` | `dwell`, `stop`, `abandoned`. Нет поля — `gt` | 1.0 |
| `timeSec` | integer | Время в области. `stop`, `abandoned` — не меньше 1 | 1.0 |
| `width` | number | С 0.15.0. `stripe`: ширина полосы вокруг линии. Нет поля — 5 | 1.0 |
| `zone` | object | Обязательна. `line` и `stripe` — `shape: line` или (с 0.15.0) `polyline`; остальные виды — `rect` или `polygon`. Свойства зоны 0.15.0 — как у детектора | 1.0 |
| `zoneTo` | object | Только `a2a`: вторая область (многоугольник) | 1.0 |

## Состояние (`status.observed`)

Своих свойств нет.

## Изменения

| Версия | Что |
|---|---|
| 1.3 | Пункт отчёта о пробелах F122: поддетекторы принимает и трекер людей (analyticsKind: humanTracker, vms.detector/1 1.6) — все виды, кроме abandoned. Поля и типы не менялись |
| 1.2 | Пункт отчёта о пробелах F122: поддетекторы принимают и детектор номеров (detectorKind: lpr), детектор поз (analyticsKind: pose), детектор СИЗ (ppe) и детектор штрихкодов (barcode) — все виды, кроме abandoned; детекторы лиц (faceTV, faceVA, faceVL) — только line, enter, dwell. GET /units/{uid}/creatable сужает subdetectorKind и под ними, а под детектором, который поддетекторов не принимает, отдаёт строку subdet с allowed: false, reason NOT_SUPPORTED (до 1.2 — allowed: true, а создание давало 422 noSubdetectors). Поля и типы не менялись |
| 1.1 | Контракт 0.40.0, пункт отчёта о пробелах F223: поддетекторы принимает и детектор контроля оператора (analyticsKind: operatorControl) — только dwell, enter, line; GET /units/{uid}/creatable у детектора отдаёт в schema вида subdet перечень subdetectorKind, суженный под этот детектор. Поля и типы не менялись |
| 1.0 | Профиль перенесён в файл из api/fixtures/demo.json и api/BACKEND.md, контракт 0.25.0. Поля до переноса — с 1.0; когда какое поле появилось в контракте — api/README.md, «Что добавлено в …» |
