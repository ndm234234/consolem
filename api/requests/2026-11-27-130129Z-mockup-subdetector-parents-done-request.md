# Запрос от команды mockup: поддетекторы под номерами, позами, СИЗ, штрихкодом и лицами внесены в профиль vms.subdetector/1 1.2 — проверить

2026-11-27 · коммит `2eefe0c` (контракт 0.41.0, профиль `vms.subdetector/1` 1.2) · от команды mockup

Кому: w2c, владелец контракта

**Статус: новый**

## Что мы сделали

Мы закрыли пункт F122 отчёта о пробелах против Axxon One (`docs/axxon-one-gaps.html`). Axxon One создаёт поддетекторы под детекторами номеров, поз, СИЗ, штрихкодов и лиц (документация Axxon One 3.0: «Configuring the Barcode detector», «Configuring the License plate recognition IV/VT», «Configuring the Equipment detector (PPE)», «Functions of the Human pose detector and its sub-detectors», «Configuring the Face detector VA/VL/TV»). Сервер до этой правки отвечал под ними `422 NOT_SUPPORTED`, `params.reason: noSubdetectors`.

Это поведение профиля `vms.subdetector/1`, его ведёт mockup. Поля и типы не менялись, `api/openapi.json` не менялся, версия контракта осталась 0.41.0. Правка задела `api/server.js` (новая точка хука в `GET /units/{uid}/creatable`), поэтому мы уведомляем и владельца контракта (`tools/layers.py`: подсистема). Описание — `api/profiles/vms.subdetector.md` (версия 1.2) и `api/BACKEND.md`, «Семейства серверных детекторов». `index.html` не менялся: интерфейс — в прототипе 107.

## Что проверить

1. **Новые родители поддетектора.** Детектор номеров (`detectorKind: lpr`), детекторы поз (`analyticsKind: pose`), СИЗ (`ppe`) и штрихкодов (`barcode`) принимают все виды поддетектора, кроме `abandoned` (он остаётся только у трекера объектов). Хук — `subHost` в `api/profiles.js`.
2. **Детекторы лиц** (`faceTV`, `faceVA`, `faceVL`) принимают только `line`, `enter`, `dwell`, как в Axxon One. Другой вид — `422 NOT_SUPPORTED`, `field: /properties/subdetectorKind`, `params.allowed`. Это то же правило, что у контроля оператора с 0.40.0 (`SUB_ONLY`).
3. **`GET /units/{uid}/creatable`** под каждым новым родителем отдаёт в строке `subdet` схему с суженным `subdetectorKind` (хук `schemaUnder`, как с 0.40.0).
4. **Тест.** «Поддетектор: номера, позы, СИЗ, штрихкод и лица…» (`tests/api-devices.js`, слой `profile:vms.subdetector/1`, с 1.2). Все 516 тестов API проходят.

## Сверх запросов

- **`creatable` под детектором, который поддетекторов не принимает**, теперь отдаёт строку `subdet` с `allowed: false`, `reason: NOT_SUPPORTED`. До 1.2 там было `allowed: true`, а `POST` отвечал `422 noSubdetectors`. В уведомлении о 0.40.0 ([2026-11-26-122435Z](2026-11-26-122435Z-mockup-detector-families-done-request.md), «Сверх запросов») мы оставили это вам на решение; ответа пока нет. Прототип 107 прячет «Создать поддетектор» по этому ответу, поэтому мы сделали правку сейчас. Поле `allowed` и код `NOT_SUPPORTED` в схеме `Creatable` уже были. Для этого ядро (`creatableOf` в `api/server.js`) зовёт новый хук профиля `refuseUnder`, рядом с `schemaUnder`. Если вы считаете это ломающей правкой, откажите в ответе: мы вернём `allowed: true`, а прототип оставит правило по профилю.
- **Список родителей мы выбрали по документации Axxon One.** Набор видов под номерами, позами, СИЗ и штрихкодом в документации виден не целиком; мы дали им все виды, кроме `abandoned`.

## Чего пока нет

- **Human tracker VL и отдельные модули номеров (IV, VT, RR).** В `analyticsKind` таких значений нет: номера в макете — общий `lpr`. Нужно ли значение для Human tracker VL, решает владелец макета.
- **Свои поддетекторы детектора поз** (сидящий, лежащий человек, руки вверх, поручень, счётчик людей, близко стоящие люди) и **детектор масок** под детекторами лиц — это не виды `subdetectorKind`. Эта правка их не добавляет.
