#!/usr/bin/env python3
"""Проверки целостности API основного макета (index.html).

1. Контракт api/openapi.json: OpenAPI 3.1, у каждой операции operationId (без повторов) и тег
   из списка тегов, каждая ссылка $ref ведёт в существующую схему.
2. Наборы api/fixtures/demo.json и one-domain.json: каждая запись соответствует схеме контракта, id
   уникальны, ссылки между записями ведут в существующие записи. Возможности (reference.capabilities) —
   из контракта, demo умеет весь контракт, данные набора не противоречат объявленному; one-domain.json
   собран из нынешнего demo.json (tools/profile_fixture.py --check).
   Описания видов (kinds) — схемы в подмножестве JSON Schema с расширениями x-*, родители и профили существуют; объекты (units) —
   uid уникальны, свойства проходят схему вида (ConsolemContract.validate из contract.js), родитель из parents,
   x-ref разрешаются; ссылки правил, прав, обходов, удержаний, отметок ведут в объекты склада.
3. api/openapi.js и api/fixture.js собраны из нынешних JSON (tools/build_api.py --check).
4. В HTML прототипа не осталось констант с данными сервера. Пока раздел не переведён, его константы
   перечислены в PENDING: такой список сокращается от этапа к этапу и не может отставать —
   константа из списка, которой уже нет в HTML, тоже ошибка.
5. Интерфейс не трогает внутренности сервера: ConsolemServer создаётся один раз и уходит в
   клиент, server.handle и данные сервера в HTML не встречаются.
6. Каждая операция контракта реализована в api/server.js и каждый маршрут сервера описан в контракте.
7. Числа в api/BACKEND.md (сколько операций и служебных) совпадают с контрактом.
8. Ломающие изменения против контракта старого макета (git show 47d1310:api/openapi.json) названы в api/README.md;
   без git или без этого коммита в истории — пропуск с пометкой.
9. Граница слоёв (tools/layers.py): x-layer стоит только у схемы, пути или поля общей схемы; значение — профиль, video или vms;
   общие схемы и пути не ссылаются на схемы подсистем; поля подсистем в общих схемах названы в KNOWN_LEAKS;
   id профиля в описании поля общей схемы — пометка поля или пример из EXAMPLE_MENTIONS.
10. Профили в файлах api/profiles/*.json (tools/profile_files.py): формат файлов; раздел profiles наборов — из файлов;
   виды несут поля профиля того же типа, status объектов — по схеме профиля; версия профиля против --profiles-base
   (по умолчанию origin/main; без git — пропуск); зависимости uses есть и не младше.
11. Слой у каждого теста API (node tools/api_tests_registry.mjs): слой — mechanism, video или profile:<id> с файлом в api/profiles/;
   since — только у теста профиля, вида M.m, старшая цифра как в /N, не старше версии профиля; INFO — тесты механизма на видах набора
   и профили без тестов. Тесты — --tests DIR (по умолчанию tests).
12. Протокол своей страницы setup/1: api/setup-ui.schema.json — ключевые слова из разрешённого списка, ссылки в $defs, у сообщений
   x-direction, proto и type, примеры проходят схему; таблицы «Сообщения» api/SETUP-UI.md — те же сообщения и направления;
   problem и problemError — поля Problem и ProblemError контракта; описание setupUi ссылается на api/SETUP-UI.md.
13. Мост страницы подсистемы: у каждой операции api/openapi.json (и api/*.openapi.json, api/profiles/*.openapi.json) — x-bridge
   (read, act, draft) или причина в BRIDGE_CLOSED; read — только GET или BRIDGE_READ_POST, act — только BRIDGE_ACT, draft — только
   BRIDGE_DRAFT; без x-bridge у /test, /test/*, test-support и deprecated; в BRIDGE_CLOSED — только операции описаний; кривое
   описание (paths не объект, путь не объект) — отказ строкой; поддельные описания проверяют саму проверку (bridge_selfcheck).
С --lint дополнительно: npx @redocly/cli lint api/openapi.json.

Запуск из корня репозитория: python3 tools/check_api.py [--lint] [--api DIR] [--page FILE] [--profiles-base REF]
(--page — прототип вместо index.html; --api — копия папки API вместо api; в документе выше пути даны для умолчаний)
Код выхода 1, если что-то не прошло.
"""
import glob
import json
import os
import re
import subprocess
import sys

import cli_paths
import generic_legacy
import layers
import mechanism
import profile_files

API = cli_paths.opt("api", "api")
PROTOTYPE = cli_paths.opt("page", "index.html")
TESTS = cli_paths.opt("tests", "tests")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
METHODS = ("get", "post", "put", "patch", "delete")

# Константы с данными сервера в HTML прототипа: образец → что это
DATA_CONSTANTS = {
    r"\bconst servers\s*=\s*\[\s*\{": "серверы",
    r"\bconst domains\s*=\s*\[\s*\{": "домены",
    r"\bfunction bulkCams\b": "генерация камер",
    r"\bdemoPad\(": "демо-генерация устройств",
    r"\bmkFolder\(\"": "папки",
    r"\bconst arch\s*=\s*\[\s*\{": "хранилища",
    r"\bconst RECORDS_TO\s*=": "привязка записи",
    r"\bconst SERVER_GPU\s*=\s*\{\s*\w": "GPU серверов",
    r"HIJKLMNOP": "диски серверов",
    r"\bconst DEVICE_DISCOVERY_SEED\s*=": "сеть для поиска устройств",
    r"\bconst FOUND_PLAN\s*=": "что находит поиск",
    r"\bconst rules\s*=\s*\[\s*\{": "правила",
    r"\bruleFires\s*=\s*\{\s*\w": "срабатывания правил",
    r"\bfunction accSeed\b": "права",
    r"\bconst SETTINGS\s*=[^;]*value:": "значения опций",
    r"\bconst LOG_EVENTS\s*=": "журнал",
    # «Автоматизация» основного макета (прототип API)
    r"\bconst SCHEDS\s*=\s*\[\s*\{": "расписания",
    r"\bconst DAY_GROUPS\s*=\s*\[\s*\{": "особые дни",
    r"\bconst OBJ_MODES\s*=\s*\[\s*\{": "режимы объекта",
    r"\bconst MAINT_WINDOWS\s*=\s*\[\s*\{": "окна обслуживания",
    r"\bfunction ruleHistInit\b": "история версий правил",
    r"\bfunction ruleFiresInit\b": "демо-запуски правил",
    r"\bconst RULE_(LAYOUTS|MONS)\s*=\s*\[\s*\"": "раскладки и мониторы видеостены",
    r"\bconst RULE_(IDS|DEV)_A\s*=": "старые id в правилах, поля устройств (таблица этапа А)",
}
# Ещё не переведены на API: при переводе их убирали отсюда вместе с константами; теперь переведено всё
PENDING = set()


class Report:
    def __init__(self):
        self.failed = 0

    def ok(self, name, note=""):
        print(f"PASS  {name}{' — ' + note if note else ''}")

    def fail(self, name, problems):
        self.failed += 1
        print(f"FAIL  {name} — {len(problems)}:")
        for p in problems[:25]:
            print(f"      {p}")
        if len(problems) > 25:
            print(f"      … и ещё {len(problems) - 25}")

    def info(self, text):
        print(f"INFO  {text}")

    def check(self, name, problems, note=""):
        self.fail(name, problems) if problems else self.ok(name, note)


def load(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return json.load(f)


def read(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


# ===== Сверка значения со схемой =====
# Подмножество JSON Schema, которым пользуется контракт: type (и списком, с null), properties,
# required, additionalProperties, items, enum, $ref, anyOf/oneOf, format, minimum/maximum, pattern, minLength, minItems.
# Поле, которого нет в схеме, — расхождение: контракт описывает всё, что есть в данных

FORMATS = {
    "uuid": re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    "date": re.compile(r"^\d{4}-\d\d-\d\d$"),
    "date-time": re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$"),
}


def kind_of(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def validate(spec, schema, value, where, out):
    if len(out) > 60 or schema is None:
        return
    if "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        return validate(spec, spec["components"]["schemas"][name], value, where, out)
    alts = schema.get("anyOf") or schema.get("oneOf")
    if alts:
        for alt in alts:
            errs = []
            validate(spec, alt, value, where, errs)
            if not errs:
                return
        first = next((a for a in alts if a.get("type") != "null"), alts[0])
        errs = []
        validate(spec, first, value, where, errs)
        out.extend(errs or [f"{where}: не подходит ни под один вариант"])
        return
    types = schema.get("type")
    types = [types] if isinstance(types, str) else (types or [])
    k = kind_of(value)
    if types and k not in types and not (k == "integer" and "number" in types):
        out.append(f"{where}: {k} вместо {'|'.join(types)}")
        return
    if "enum" in schema and value not in schema["enum"]:
        out.append(f"{where}: {value!r} нет в перечислении")
    if k == "string":
        fmt = FORMATS.get(schema.get("format"))
        if fmt and not fmt.match(value):
            out.append(f"{where}: {value!r} — не {schema['format']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            out.append(f"{where}: {value!r} не подходит под {schema['pattern']}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            out.append(f"{where}: короче {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            out.append(f"{where}: длиннее {schema['maxLength']}")
    if k in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"]:
            out.append(f"{where}: {value} меньше {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            out.append(f"{where}: {value} больше {schema['maximum']}")
    if k == "array" and "minItems" in schema and len(value) < schema["minItems"]:
        out.append(f"{where}: меньше {schema['minItems']} элементов")
    if k == "array" and "maxItems" in schema and len(value) > schema["maxItems"]:
        out.append(f"{where}: больше {schema['maxItems']} элементов")
    if k == "array" and "items" in schema:
        for i, item in enumerate(value):
            validate(spec, schema["items"], item, f"{where}[{i}]", out)
    if k == "object":
        props = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                out.append(f"{where}: нет обязательного поля {name}")
        extra = schema.get("additionalProperties", True)
        for name, v in value.items():
            if name in props:
                validate(spec, props[name], v, f"{where}.{name}", out)
            elif extra is False:
                out.append(f"{where}: поле {name} не описано в контракте")
            elif isinstance(extra, dict):
                validate(spec, extra, v, f"{where}.{name}", out)


# ===== 1. Контракт =====

def check_contract(rep, spec):
    problems = []
    if not str(spec.get("openapi", "")).startswith("3.1"):
        problems.append(f"openapi: {spec.get('openapi')} вместо 3.1.x")
    tags = {t["name"] for t in spec.get("tags", [])}
    seen = {}
    for path, item in spec["paths"].items():
        for method in METHODS:
            op = item.get(method)
            if not op:
                continue
            where = f"{method.upper()} {path}"
            oid = op.get("operationId")
            if not oid:
                problems.append(f"{where}: нет operationId")
            elif oid in seen:
                problems.append(f"{where}: operationId {oid} уже у {seen[oid]}")
            else:
                seen[oid] = where
            for t in op.get("tags", []) or [None]:
                if t not in tags:
                    problems.append(f"{where}: тег {t} не объявлен")
    schemas = spec["components"]["schemas"]

    def refs(node, where):
        if isinstance(node, dict):
            r = node.get("$ref")
            if isinstance(r, str):
                parts = r.lstrip("#/").split("/")
                target = spec
                for p in parts:
                    target = target.get(p) if isinstance(target, dict) else None
                if target is None:
                    problems.append(f"{where}: ссылка {r} никуда не ведёт")
                # Сверка схем (здесь и в api/contract.js) понимает только ссылки на компонент целиком
                elif not re.fullmatch(r"#/components/(schemas|responses|headers)/\w+", r):
                    problems.append(f"{where}: ссылка {r} — только на компонент целиком: #/components/schemas/<имя>")
            for k, v in node.items():
                refs(v, f"{where}/{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                refs(v, f"{where}/{i}")

    refs(spec, "#")
    # Ключевые слова схем, которых не понимают сверки (здесь и в api/contract.js): они пропустили бы их молча
    unsupported = {"allOf", "not", "if", "then", "else", "const", "patternProperties", "prefixItems", "maxLength", "maxItems",
                   "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "uniqueItems", "dependentRequired"}

    def keywords(node, where):
        if isinstance(node, dict):
            bad = unsupported & set(node) if ("type" in node or "$ref" in node or "properties" in node or "allOf" in node) else set()
            problems.extend(f"{where}: {k} — сверка схем его не понимает" for k in sorted(bad))
            for k, v in node.items():
                if k not in ("description", "x-enum-descriptions", "example", "examples"):
                    keywords(v, f"{where}/{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                keywords(v, f"{where}/{i}")

    keywords(spec["components"]["schemas"], "#/components/schemas")
    rep.check("Контракт: OpenAPI 3.1, operationId, теги, ссылки $ref", problems, f"{len(seen)} операций, {len(schemas)} схем")
    return seen


# ===== 1а. Мост страницы подсистемы (x-bridge) =====
# Что своя страница подсистемы (setupUi.mode: iframe) может вызвать через consolem, api/SETUP-UI.md, «Шаг 2: мост к механизму».
# read — consolem выполняет сразу; act — выполняет сразу, команда видна в журнале; draft — кладёт шаг в черновик карточки,
# выполняет по «Применить». Нет x-bridge — мост отказывает (NOT_SUPPORTED), и тогда причина — строкой в BRIDGE_CLOSED:
# новую операцию проверка не пропустит, пока о ней не решили.
BRIDGE_VALUES = ("read", "act", "draft")
BRIDGE_DRAFT = {"patchUnit", "createUnits", "deleteUnit", "moveUnit", "deleteObjects", "createOperation"}
BRIDGE_READ_POST = {"validateUnits"}
# act — только команды объекта и долгая работа, которую карточка consolem тоже запускает сразу
BRIDGE_ACT = {"runUnitAction", "runKindAction", "cancelOperation", "startDiscovery", "stopDiscovery", "uploadFile"}
_ACCESS = "права и сеанс — вкладка «Доступ» у consolem своя"
_AUTOMATION = "автоматизация — редактор правил, расписаний и режимов у consolem свой, и чтение, и запись"
_VIDEO = "работа оператора с видео и архивом, а не настройка объекта"
_EXPORT = "выгрузка — работа оператора, рамка не сохраняет файлы"
_LIVE = "живое видео — после отдельного API видео (решение О5)"
_SYSTEM = "настройки системы и ключи — вне склада объектов, и чтение, и запись"
_STORAGE = "хранилище, а не объект страницы"
_OLD = "устарела"
_TEST = "служебная операция стенда (test-support) — никогда"
_REDO = "откат и повтор ведёт consolem: тост «Отменить», журнал операций"
BRIDGE_CLOSED = {
    "getMe": _ACCESS, "getAccess": _ACCESS, "applyAccess": _ACCESS, "syncCatalog": _ACCESS,
    "listAccessUsers": _ACCESS, "listAccessGroups": _ACCESS, "listAccessHistory": _ACCESS, "listAccessCellHistory": _ACCESS,
    "listRoleObjects": _ACCESS, "listStreamAccounts": _ACCESS, "createStreamAccount": _ACCESS, "patchStreamAccount": _ACCESS,
    "deleteStreamAccount": _ACCESS, "resetStreamAccountPassword": _ACCESS,
    "revertOperation": _REDO, "redoOperation": _REDO, "retryFailedOperation": _REDO,
    "pauseOperation": _OLD, "resumeOperation": _OLD,
    "listMaintenanceWindows": _OLD, "createMaintenanceWindow": _OLD, "getMaintenanceWindow": _OLD,
    "putMaintenanceWindow": _OLD, "deleteMaintenanceWindow": _OLD,
    "openUnitSetupUi": "адрес страницы берёт сам consolem",
    "getSettings": _SYSTEM, "patchSettings": _SYSTEM, "listLicenseKeys": _SYSTEM, "getLicenseKey": _SYSTEM, "createLicenseKey": _SYSTEM,
    "patchLicenseKey": _SYSTEM, "deleteLicenseKey": _SYSTEM,
    "exportJournal": "файл журнала — рамка не сохраняет файлы",
    "createRule": _AUTOMATION, "putRule": _AUTOMATION, "updateRules": _AUTOMATION, "reorderRules": _AUTOMATION,
    "listRuleFires": _AUTOMATION, "listRuleVersions": _AUTOMATION, "testRule": _AUTOMATION, "runRule": _AUTOMATION,
    "retryRuleFire": _AUTOMATION, "createSchedule": _AUTOMATION, "putSchedule": _AUTOMATION, "deleteSchedule": _AUTOMATION,
    "listDayGroups": _AUTOMATION, "createDayGroup": _AUTOMATION, "getDayGroup": _AUTOMATION, "putDayGroup": _AUTOMATION,
    "deleteDayGroup": _AUTOMATION, "putModes": _AUTOMATION, "setModeCurrent": _AUTOMATION,
    "listRulePrompts": "работа оператора — ответ на вопрос правила", "answerRulePrompt": "работа оператора — ответ на вопрос правила",
    "putScenarios": "документ сценариев правит consolem",
    "startUnitLive": _LIVE, "moveUnitLive": _LIVE,
    "startUnitTalk": _VIDEO, "getUnitTimeline": _VIDEO, "getUnitPlayback": _VIDEO, "listUnitHolds": _VIDEO,
    "createUnitHold": _VIDEO, "deleteHold": _VIDEO, "verifyHold": _VIDEO, "listUnitBookmarks": _VIDEO,
    "createUnitBookmark": _VIDEO, "fetchUnitArchive": _VIDEO, "putUnitPtz": _VIDEO, "deleteUnitPtz": _VIDEO,
    "putUnitPreset": _VIDEO, "deleteUnitPreset": _VIDEO, "getUnitRecordingDays": _VIDEO,
    "putUnitRecordingTarget": "запись настройки мимо черновика карточки",
    "getExportGrant": _EXPORT, "getExportReference": "выгрузка — работа оператора, а не настройка объекта", "checkExport": _EXPORT, "listExports": _EXPORT,
    "createExport": _EXPORT, "getExport": _EXPORT, "deleteExport": _EXPORT, "cancelExport": _EXPORT,
    "retryExport": _EXPORT, "getExportFileLink": _EXPORT,
    "listArchiveWatches": _STORAGE, "createArchiveWatch": _STORAGE, "patchArchiveWatch": _STORAGE, "deleteArchiveWatch": _STORAGE,
    "listArchiveScans": _STORAGE, "createArchiveScan": _STORAGE, "deleteArchiveScan": _STORAGE,
    "stream": "поток — вместо него сообщение subscribe", "putStreamWatch": "поток — вместо него сообщение subscribe",
    "assistTurn": "ассистент — служебное",
    "testReset": _TEST, "testClock": _TEST, "testEvent": _TEST, "testStreamElsewhere": _TEST, "testPutKind": _TEST,
}


def bridge_specs():
    """Описания, чьи операции размечает x-bridge: api/openapi.json и, если появятся, api/*.openapi.json и api/profiles/*.openapi.json."""
    out = [(f"{API}/openapi.json", load(f"{API}/openapi.json"))]
    for pat in (f"{API}/*.openapi.json", f"{API}/profiles/*.openapi.json"):
        for p in sorted(glob.glob(os.path.join(ROOT, pat))):
            out.append((os.path.relpath(p, ROOT), load(os.path.relpath(p, ROOT))))
    return out


def bridge_problems(specs, closed=None, draft=None, read_post=None, act=None):
    """Отказы разметки x-bridge и счёт {read, act, draft, closed} по описаниям specs: [(имя, описание)].
    Кривой ввод (описание или путь не объект, paths: null) — строка отказа, а не сбой проверки."""
    closed = BRIDGE_CLOSED if closed is None else closed
    draft = BRIDGE_DRAFT if draft is None else draft
    read_post = BRIDGE_READ_POST if read_post is None else read_post
    act = BRIDGE_ACT if act is None else act
    problems, count, seen = [], {"read": 0, "act": 0, "draft": 0, "closed": 0}, set()
    for name, spec in specs:
        if not isinstance(spec, dict):
            problems.append(f"{name}: описание не объект")
            continue
        paths = spec.get("paths") or {}
        if not isinstance(paths, dict):
            problems.append(f"{name}: paths не объект")
            continue
        for path, item in paths.items():
            if not isinstance(item, dict):
                problems.append(f"{name}: {path}: не объект")
                continue
            for method in METHODS:
                op = item.get(method)
                if not isinstance(op, dict):
                    continue
                oid = op.get("operationId") or f"{method.upper()} {path}"
                where = f"{name}: {oid}"
                seen.add(oid)
                has = "x-bridge" in op
                val = op.get("x-bridge")
                tags = op.get("tags") if isinstance(op.get("tags"), list) else []
                test = path == "/test" or path.startswith("/test/") or "test-support" in tags
                if not has:
                    if oid in closed:
                        count["closed"] += 1
                    else:
                        problems.append(f"{where}: нет x-bridge и нет в BRIDGE_CLOSED")
                    continue
                if oid in closed:
                    problems.append(f"{where}: есть x-bridge и строка в BRIDGE_CLOSED — нужно одно")
                if test:
                    problems.append(f"{where}: x-bridge у служебной операции (/test/*, test-support)")
                if op.get("deprecated"):
                    problems.append(f"{where}: x-bridge у устаревшей операции")
                if val not in BRIDGE_VALUES:
                    problems.append(f"{where}: x-bridge {val!r} — не из {', '.join(BRIDGE_VALUES)}")
                    continue
                if val == "read" and method != "get" and oid not in read_post:
                    problems.append(f"{where}: read у {method.upper()} — только GET или BRIDGE_READ_POST")
                if val == "draft" and oid not in draft:
                    problems.append(f"{where}: draft — только операции BRIDGE_DRAFT")
                if val == "act" and oid not in act:
                    problems.append(f"{where}: act — только операции BRIDGE_ACT")
                count[val] += 1
    problems += [f"BRIDGE_CLOSED: {oid} — такой операции нет ни в одном описании" for oid in sorted(set(closed) - seen)]
    return problems, count


def bridge_selfcheck():
    """Проверка самой проверки: поддельные описания, на которых bridge_problems обязана отказать, и кривой ввод."""
    out = []
    cases = [
        ("act вне BRIDGE_ACT", {"paths": {"/x": {"post": {"operationId": "doX", "x-bridge": "act"}}}}, "act — только операции BRIDGE_ACT"),
        ("путь /test без косой черты", {"paths": {"/test": {"post": {"operationId": "poke", "x-bridge": "act"}}}}, "служебной операции"),
        ("paths: null", {"paths": None}, None),
        ("описание не объект", None, "описание не объект"),
        ("путь не объект", {"paths": {"/y": None}}, "/y: не объект"),
    ]
    for title, spec, want in cases:
        try:
            got, _ = bridge_problems([("поддельное", spec)], closed={}, draft=set(), read_post=set(), act=set())
        except Exception as e:  # noqa: BLE001 — любой сбой на кривом вводе и есть отказ
            out.append(f"проверка моста на «{title}» упала: {type(e).__name__}: {e}")
            continue
        if want and not any(want in g for g in got):
            out.append(f"проверка моста не отказала на «{title}»: {got}")
        if not want and got:
            out.append(f"проверка моста отказала на «{title}» без причины: {got}")
    return out


def check_bridge(rep, specs):
    problems, c = bridge_problems(specs)
    problems = bridge_selfcheck() + problems
    rep.check("Мост страницы: x-bridge у каждой операции или причина в BRIDGE_CLOSED", problems,
              f"read {c['read']}, act {c['act']}, draft {c['draft']}, закрыто {c['closed']}")


# ===== 2. Эталонный набор =====

def check_fixture(rep, spec, fx, label="Эталонный набор"):
    # Раздел набора → схема записи. network и discovery — данные стенда, а не ответы API:
    # их строение проверяется ниже, в ссылках
    collections = {
        "domains": "Domain", "servers": "Server", "devices": "Device", "folders": "Folder",
        "archives": "Archive", "volumes": "Volume", "rules": "Rule", "ruleFires": "RuleFire", "ruleVersions": "RuleVersion",
        "schedules": "Schedule", "dayGroups": "DayGroup", "maintenanceWindows": "MaintenanceWindow",
        "licenses": "License", "licenseKeys": "LicenseKey", "journal": "JournalEvent", "streamAccounts": "StreamAccount", "archiveWatches": "ArchiveWatch", "archiveScans": "ArchiveScan",
    }
    singles = {"settings": "Settings", "reference": "Reference", "modes": "Modes"}
    problems = []
    total = 0
    # Записи стенда шире ответов: состав папки и права целиком живут в наборе, наружу идут страницами
    schemas = spec["components"]["schemas"]
    # Схем записей старых разделов (Domain, Device…) в контракте нет — их записи выводятся из units и проверяются
    # по схемам видов (check_units)
    collections = {k: n for k, n in collections.items() if n in schemas}
    ref = lambda n: {"type": "array", "items": {"$ref": f"#/components/schemas/{n}"}}
    access = {"type": "object", "additionalProperties": False, "required": ["version", "roles", "users", "groups", "catalogs", "history", "cellHistory"],
              "properties": dict(schemas["Access"]["properties"], roles=ref("Role"), users=ref("AccessUser"), groups=ref("UserGroup"), history=ref("AccessHistoryEntry"), cellHistory=ref("AccessCellEntry"))}
    for key, name in collections.items():
        for i, rec in enumerate(fx.get(key, [])):
            validate(spec, {"$ref": f"#/components/schemas/{name}"}, rec, f"{key}[{i}]", problems)
            total += 1
    validate(spec, access, fx.get("access"), "access", problems)
    for key, name in singles.items():
        validate(spec, {"$ref": f"#/components/schemas/{name}"}, fx.get(key), key, problems)
    cand = spec["components"]["schemas"]["DiscoveryCandidate"]
    net_schema = dict(cand, properties=dict(cand["properties"], domainIds={"type": "array", "items": {"type": "string", "format": "uuid"}},
                                                         # С 0.36.0: какие серверы видят устройство (нет — все серверы домена); serverId находки сервер выводит из него
                                                         serverIds={"type": "array", "items": {"type": "string", "format": "uuid"}}))
    for i, rec in enumerate(fx.get("network", [])):
        validate(spec, net_schema, rec, f"network[{i}]", problems)
    # modeManual — режим, включённый вручную ({ modeId, until } или null): состояние стенда, ответ — GET /modes/current
    if fx.get("modeManual") is not None:
        validate(spec, {"$ref": "#/components/schemas/ModeCurrentWrite"}, fx["modeManual"], "modeManual", problems)
    # layouts — раскладки дерева (GET /kinds → layouts): записи по схеме TreeLayout, согласие с видами — check_mechanism
    for i, rec in enumerate(fx.get("layouts") or []):
        validate(spec, {"$ref": "#/components/schemas/TreeLayout"}, rec, f"layouts[{i}]", problems)
        total += 1
    # kinds, profiles, units — описания видов, профили, объекты склада: их проверяет check_units
    known = set(collections) | set(singles) | set(generic_legacy.OLD_TABLES) | {"access", "$comment", "version", "capturedAt", "timezone", "me", "network", "discovery", "modeManual", "stand", "scenarioDocs", "relays",
                                                "kinds", "profiles", "units", "layouts"}
    problems += [f"раздел {k} не описан в check_api.py" for k in fx if k not in known]
    rep.check(f"{label} соответствует схемам контракта", problems, f"{total} записей + access, settings, reference")

    # Уникальность и ссылки
    problems = []
    ids = {}

    def own(kind, recs):
        for r in recs:
            if r["id"] in ids:
                problems.append(f"{kind} {r['id']}: id уже у {ids[r['id']]}")
            ids[r["id"]] = kind
        return {r["id"]: r for r in recs}

    acc = fx["access"]
    domains = own("domain", fx["domains"])
    servers = own("server", fx["servers"])
    devices = own("device", fx["devices"])
    folders = own("folder", fx["folders"])
    archives = own("archive", fx["archives"])
    volumes = own("volume", fx["volumes"])
    rules = own("rule", fx["rules"])
    own("ruleFire", fx["ruleFires"])
    own("ruleVersion", fx["ruleVersions"])
    schedules = own("schedule", fx["schedules"])
    day_groups = own("dayGroup", fx["dayGroups"])
    modes = own("mode", fx["modes"]["items"])
    windows = own("window", fx["maintenanceWindows"])
    # Раскладки клиента и мониторы: enum полей действий (reference.layouts и monitors сняты в 0.32.0)
    layouts = {v: None for v in rule_field_enum(fx, "layoutId")}
    monitors = {v: None for v in rule_field_enum(fx, "monitorId")}
    network = own("candidate", fx["network"])
    roles = own("role", acc["roles"])
    users = own("user", acc["users"])
    groups = own("group", acc["groups"])
    catalogs = own("catalog", acc["catalogs"])
    own("history", acc["history"])
    own("journal", fx["journal"])

    def must(table, value, where, kind):
        if value is not None and value not in table:
            problems.append(f"{where}: нет {kind} {value}")

    for s in servers.values():
        must(domains, s["domainId"], f"server {s['name']}", "домена")
    for d in devices.values():
        w = f"device {d['name']} ({d['id']})"
        must(domains, d["domainId"], w, "домена")
        must(devices, d["parentId"], w, "родителя")
        must(servers, d.get("serverId"), w, "сервера")
        must(archives, d.get("archiveId"), w, "хранилища")
        must(devices, d.get("cameraId"), w, "камеры")
        for x in d.get("extraArchives", []):
            must(archives, x["archiveId"], w, "хранилища")
        for x in d.get("recordDetectorIds", []):
            must(devices, x, w, "детектора")
        p = devices.get(d["parentId"])
        if p and p["domainId"] != d["domainId"]:
            problems.append(f"{w}: домен не как у родителя")
    for f in folders.values():
        w = f"folder {f['name']}"
        must(domains, f["domainId"], w, "домена")
        must(folders, f["parentId"], w, "родителя")
        for x in f["deviceIds"]:
            must(devices, x, w, "устройства")
        p = folders.get(f["parentId"])
        if p and p["domainId"] != f["domainId"]:
            problems.append(f"{w}: домен не как у родителя")
    for a in archives.values():
        w = f"archive {a['name']}"
        if (a["serverId"] is None) == (a["domainId"] is None):
            problems.append(f"{w}: владелец — ровно один из serverId и domainId")
        must(servers, a["serverId"], w, "сервера")
        must(domains, a["domainId"], w, "домена")
    for v in volumes.values():
        must(archives, v["archiveId"], f"volume {v['name']}", "хранилища")
    # Правила: цели — существующие устройства и области (удалённые — в gone по имени), расписания, режимы, роли
    def target(t, w):
        if not t:
            return
        for x in t["include"]:
            # Элемент цели: {uid} — объект, {area, uid} — область
            kind = x.get("area", "device")
            must({"device": devices, "folder": folders, "server": servers, "domain": domains}[kind], x["uid"], w, kind)
        for x in t["exclude"]:
            must(devices, x, w, "устройства")

    def step_refs(lst, w):
        for a in lst:
            if a.get("control") == "waitEvent":
                target(a["event"]["target"], w)
            for k in ("yes", "no"):
                step_refs(a.get(k, []), w)
            for lv in a.get("levels", []):
                must(roles, lv["roleId"], w, "роли")
            target(a.get("target"), w)
            must(roles, a.get("roleId"), w, "роли")
            must(rules, a.get("ruleId"), w, "правила")
            must(layouts, a.get("layoutId"), w, "раскладки")
            must(monitors, a.get("monitorId"), w, "монитора")

    for r in rules.values():
        w = f"rule {r['name']}"
        must(servers, r["serverId"], w, "сервера")
        must(roles, r["runAsRoleId"], w, "роли")
        for t in r["triggers"]:
            target(t["target"], w)
        for c in r["conditions"]:
            target(c.get("target"), w)
            must(schedules, c.get("scheduleId"), w, "расписания")
            for m in c.get("modeIds", []):
                must(modes, m, w, "режима")
        step_refs(r["steps"], w)
    for v in fx["ruleVersions"]:
        must(rules, v["ruleId"], f"ruleVersion {v['id']}", "правила")
    for f in fx["ruleFires"]:
        w = f"ruleFire {f['id']}"
        must(rules, f["ruleId"], w, "правила")
        for x in f["sourceDeviceIds"] + [e["deviceId"] for e in f["events"]] + [s["deviceId"] for s in f["steps"]]:
            must(devices, x, w, "устройства")
    for s in schedules.values():
        for x in s["overrides"]:
            must(day_groups, x["dayGroupId"], f"schedule {s['name']}", "группы дат")
        if s["owner"]:
            must(windows, s["owner"]["id"], f"schedule {s['name']}", "окна обслуживания")
    for m in modes.values():
        must(schedules, m["scheduleId"], f"mode {m['name']}", "расписания")
    if fx["modes"]["otherwise"] is not None:
        must(modes, fx["modes"]["otherwise"], "modes.otherwise", "режима")
    for m in modes.values():
        for r in m["off"]["ruleIds"]:
            must(rules, r, f"mode {m['name']}", "правила")
    if fx.get("modeManual"):
        must(modes, fx["modeManual"]["modeId"], "modeManual", "режима")
    for x in windows.values():
        must(schedules, x["scheduleId"], f"window {x['name']}", "расписания")
        for r in x["ruleIds"] or []:
            must(rules, r, f"window {x['name']}", "правила")
    for d in devices.values():
        must(rules, d.get("disabledByRuleId"), f"device {d['name']}", "правила")
    for c in network.values():
        for d in c["domainIds"]:
            must(domains, d, f"network {c['name']}", "домена")
        for sid in c.get("serverIds") or []:
            must(servers, sid, f"network {c['name']}", "сервера")
            if sid in servers and servers[sid].get("domainId") not in c["domainIds"]:
                problems.append(f"network {c['name']}: сервер {sid} не из доменов устройства")
    for x in fx["discovery"]:
        must(domains, x["domainId"], "discovery", "домена")
        for c in x["candidateIds"]:
            must(network, c, f"discovery {x['domainId']}", "устройства сети")
    plugins = set(fx["reference"]["access"]["plugins"])
    for r in roles.values():
        w = f"role {r['name']}"
        must(roles, r["supervision"]["roleId"], w, "роли")
        for k in r["folderAccess"]:
            if k not in folders and k not in domains:
                problems.append(f"{w}: права на {k} — нет такой папки или домена")
        for k in r["objectAccess"]:
            if k.startswith("vw:"):
                must(servers, k[3:], w, "сервера видеостены")
            elif k.startswith("macro:"):
                must(rules, k[6:], w, "правила")
            elif k.startswith("plug:"):
                if k[5:] not in plugins:
                    problems.append(f"{w}: нет плагина {k[5:]}")
            elif k not in devices and k not in archives:
                problems.append(f"{w}: права на {k} — нет такого устройства или хранилища")
    for u in users.values():
        w = f"user {u['login']}"
        for r in u["roleIds"] + list(u["roleUntil"]):
            must(roles, r, w, "роли")
        must(catalogs, u["catalogId"], w, "каталога")
        must(groups, u.get("syncedGroupId"), w, "группы")
    for g in groups.values():
        w = f"group {g['name']}"
        for r in g["roleIds"]:
            must(roles, r, w, "роли")
        for m in g["memberIds"]:
            must(users, m, w, "пользователя")
        if g["source"]:
            must(catalogs, g["source"]["catalogId"], w, "каталога")
    for h in acc["history"]:
        w = f"history {h['id']}"
        must(roles, h.get("roleId"), w, "роли")
        for r in h.get("roleIds", []):
            must(roles, r, w, "роли")
        must(users, h.get("userId"), w, "пользователя")
        must(groups, h.get("groupId"), w, "группы")
    must(users, fx["me"]["userId"], "me", "пользователя")
    logins = [u["login"] for u in users.values()]
    if len(set(logins)) != len(logins):
        problems.append("логины пользователей повторяются")
    rep.check(f"{label} цел: id уникальны, ссылки ведут в существующие записи", problems, f"{len(ids)} записей")


# ===== 2а. Описания видов, профили, объекты склада: kinds, profiles, units =====
# Подмножество JSON Schema для схем видов (описание JsonSchema в контракте) и расширения x-*.
# Незнакомый x-* клиент пропускает, поэтому он не ошибка; незнакомое ключевое слово без x- — ошибка
KIND_KEYWORDS = {"type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format",
                 "items", "minItems", "maxItems", "required", "default", "readOnly", "writeOnly", "if", "then", "else", "dependentSchemas",
                 "description", "title", "properties", "additionalProperties", "deprecated", "allOf", "examples"}
KIND_TYPES = {"string", "integer", "number", "boolean", "array", "object", "null"}
KIND_FLAGS = ("x-search", "x-immutable", "x-unique", "x-ui-filter", "x-ui-advanced")
UUID_ANY = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4000-8000-[0-9a-f]{12}")
# Первая цифра uid объектов склада: домен, сервер, устройство (и объекты незнакомых видов), папка, хранилище, том
UNIT_PREFIXES = "123456"
# Имена status профиля, которых нет в status.observed объектов набора, но которые профиль обещает (поля Device без данных
# в наборе)
PROFILE_STATUS_EXTRA = {"vms.camera/1": ["detectorKinds", "direct", "recordingTarget"]}
# Старые разделы, которые склад повторяет, пока сервер на них живёт (uid = id записи)
OLD_UNIT_TABLES = ("domains", "servers", "devices", "folders", "archives", "volumes")


def kind_schema_problems(spec, node, where, kinds, profiles, out):
    """Схема вида (или параметров действия, события) — в подмножестве, расширения x-* — в своём виде."""
    if not isinstance(node, dict):
        out.append(f"{where}: схема — не объект")
        return
    text = lambda v, w: validate(spec, {"$ref": "#/components/schemas/Text"}, v, w, out)
    out.extend(f"{where}: {k} — вне подмножества JSON Schema" for k in node if not k.startswith("x-") and k not in KIND_KEYWORDS)
    types = node.get("type")
    types = [types] if isinstance(types, str) else types if isinstance(types, list) else []
    if "type" in node and (not types or set(types) - KIND_TYPES):
        out.append(f"{where}: type {node['type']!r} — нет такого")
    if node.get("readOnly") and node.get("writeOnly"):
        out.append(f"{where}: readOnly и writeOnly вместе")
    if "enum" in node and (not isinstance(node["enum"], list) or not node["enum"]):
        out.append(f"{where}: enum — пустой или не список")
    if "required" in node:
        req = node["required"]
        if not isinstance(req, list) or not all(isinstance(x, str) for x in req):
            out.append(f"{where}: required — не список имён")
        elif "properties" in node:
            out.extend(f"{where}: required {x} — нет в properties" for x in req if x not in node["properties"])
    for key in ("properties", "dependentSchemas"):
        for name, sub in (node.get(key) or {}).items():
            kind_schema_problems(spec, sub, f"{where}/{key}/{name}", kinds, profiles, out)
    for key in ("items", "if", "then", "else"):
        if key in node:
            kind_schema_problems(spec, node[key], f"{where}/{key}", kinds, profiles, out)
    # allOf — независимые условия: каждая часть — своё if/then/else (описание JsonSchema)
    if "allOf" in node:
        if not isinstance(node["allOf"], list):
            out.append(f"{where}: allOf — не список")
        else:
            for i, part in enumerate(node["allOf"]):
                kind_schema_problems(spec, part, f"{where}/allOf/{i}", kinds, profiles, out)
    # examples — подсказки значений (с 0.30.0): список; сервер по ним не проверяет
    if "examples" in node and not isinstance(node["examples"], list):
        out.append(f"{where}: examples — не список")
    if isinstance(node.get("additionalProperties"), dict):
        kind_schema_problems(spec, node["additionalProperties"], f"{where}/additionalProperties", kinds, profiles, out)
    # Расширения
    for flag in KIND_FLAGS:
        if flag in node and not isinstance(node[flag], bool):
            out.append(f"{where}: {flag} — не boolean")
    for key in ("x-label", "x-ui-tab", "x-ui-group"):
        if key in node:
            text(node[key], f"{where}/{key}")
    if "x-enum-labels" in node:
        labels, allowed = node["x-enum-labels"], {json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v for v in node.get("enum", [])}
        if not isinstance(labels, dict):
            out.append(f"{where}: x-enum-labels — не объект")
        else:
            out.extend(f"{where}: x-enum-labels {k} — нет в enum" for k in labels if k not in allowed)
            for k, v in labels.items():
                text(v, f"{where}/x-enum-labels/{k}")
    if "x-ref" in node:
        ref = node["x-ref"]
        if not isinstance(ref, dict) or set(ref) - {"kinds", "implements", "scope", "onDelete"} or not (ref.get("kinds") or ref.get("implements")):
            out.append(f"{where}: x-ref — нужно {{kinds?, implements?, scope?, onDelete?}}, хотя бы одно из kinds и implements")
        elif ref.get("onDelete", "clear") not in ("clear", "keep"):
            out.append(f"{where}: x-ref onDelete — clear или keep")
        else:
            out.extend(f"{where}: x-ref на вид {k} — нет такого вида" for k in ref.get("kinds", []) if k not in kinds)
            out.extend(f"{where}: x-ref на профиль {p} — нет такого профиля" for p in ref.get("implements", []) if p not in profiles)
        if not {"string", "array"} & set(types):
            out.append(f"{where}: x-ref у поля не строки и не массива")
    if "x-inherit" in node and (not isinstance(node["x-inherit"], dict) or set(node["x-inherit"]) - {"merge"} or not isinstance(node["x-inherit"].get("merge", False), bool)):
        out.append(f"{where}: x-inherit — нужно {{merge: boolean}}")
    if "x-rights" in node and (not isinstance(node["x-rights"], dict) or node["x-rights"].get("scope") not in ("group", "cluster")):
        out.append(f"{where}: x-rights — нужно {{scope: group | cluster}}")
    if "x-ui-widget" in node and not isinstance(node["x-ui-widget"], str):
        out.append(f"{where}: x-ui-widget — не строка")
    if "x-ui-order" in node and not isinstance(node["x-ui-order"], int):
        out.append(f"{where}: x-ui-order — не целое")
    if "x-ui-unit" in node and not isinstance(node["x-ui-unit"], str):
        out.append(f"{where}: x-ui-unit — не строка")
    # x-bound-to — имя секрета (writeOnly) рядом
    for name, sub in (node.get("properties") or {}).items():
        bound = isinstance(sub, dict) and sub.get("x-bound-to")
        if bound and not (node["properties"].get(bound) or {}).get("writeOnly"):
            out.append(f"{where}/properties/{name}: x-bound-to {bound!r} — рядом нет такого секрета (writeOnly)")


def unit_refs(schema, value, where, units, implements, out):
    """Ссылки x-ref в свойствах объекта ведут в объекты нужного вида или профиля."""
    if not isinstance(schema, dict) or value is None:
        return
    ref = schema.get("x-ref")
    if ref:
        for i, uid in enumerate(value if isinstance(value, list) else [value]):
            at = f"{where}/{i}" if isinstance(value, list) else where
            target = units.get(uid)
            if target is None:
                out.append(f"{at}: нет объекта {uid}")
            elif not (target["kind"] in ref.get("kinds", []) or set(ref.get("implements", [])) & implements.get(target["kind"], set())):
                out.append(f"{at}: {uid} вида {target['kind']} — не из x-ref {ref}")
        return
    if isinstance(value, dict):
        for name, v in value.items():
            unit_refs((schema.get("properties") or {}).get(name), v, f"{where}/{name}", units, implements, out)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            unit_refs(schema.get("items"), v, f"{where}/{i}", units, implements, out)


def check_units(rep, spec, fx, label="Эталонный набор"):
    """Описания видов, профили и объекты склада. Свойства объектов сверяет ConsolemContract.validate из {API}/contract.js —
    тот же, что у сервера."""
    schemas = spec["components"]["schemas"]
    problems = []
    for key, name in (("kinds", "UnitKind"), ("profiles", "Profile"), ("units", "Unit")):
        if key not in fx:
            problems.append(f"нет раздела {key}")
        for i, rec in enumerate(fx.get(key, [])):
            validate(spec, {"$ref": f"#/components/schemas/{name}"}, rec, f"{key}[{i}]", problems)
    rep.check(f"{label}: kinds, profiles, units соответствуют схемам UnitKind, Profile, Unit", problems,
              f"видов {len(fx.get('kinds', []))}, профилей {len(fx.get('profiles', []))}, объектов {len(fx.get('units', []))}")
    if not all(k in fx for k in ("kinds", "profiles", "units")) or "UnitKind" not in schemas:
        return

    # Описания видов: коды и профили уникальны, родители и профили существуют, схемы — в подмножестве
    problems = []
    kinds, profiles = {}, {}
    for k in fx["kinds"]:
        if k["kind"] in kinds:
            problems.append(f"вид {k['kind']} повторяется")
        kinds[k["kind"]] = k
    for p in fx["profiles"]:
        if p["id"] in profiles:
            problems.append(f"профиль {p['id']} повторяется")
        profiles[p["id"]] = p
    levels = fx["reference"].get("access", {}).get("levels", {})

    # Право {class?, level} (ActionDescriptor.right, EventDescriptor.right, UnitKind.apiRights): класс — свой у вида
    # (access.class или access.also) или класс другого вида набора (событие источника событий судится уровнем камер, cam, а
    # своего класса cam у источника нет — как в «Правах» старого макета), нет class — основной; уровень — из уровней этого класса
    declared = {}
    for x in fx["kinds"]:
        xa = x.get("access")
        for c in ([xa] + xa.get("also", [])) if xa else []:
            declared.setdefault(c["class"], c["levels"])

    def right_problem(k, right, w):
        if not right:
            return
        acc = k.get("access")
        classes = {c["class"]: c["levels"] for c in ([acc] + acc.get("also", []) if acc else [{"class": k["kind"], "levels": ["view", "edit", "admin"]}])}
        cls = right.get("class") or (acc["class"] if acc else k["kind"])
        if cls not in classes and cls in declared:
            classes[cls] = declared[cls]
        if cls not in classes:
            problems.append(f"{w}: right {right} — класса {cls} нет ни у вида, ни у других видов набора")
        elif right["level"] not in classes[cls]:
            problems.append(f"{w}: right {right} — нет в уровнях класса {cls}")

    for code, k in kinds.items():
        w = f"вид {code}"
        problems += [f"{w}: родитель {p} — нет такого вида" for p in k["parents"] if p is not None and p not in kinds]
        problems += [f"{w}: ребёнок {c} — нет такого вида" for c in k.get("children", []) if c not in kinds]
        problems += [f"{w}: ребёнок {c} не называет его родителем" for c in k.get("children", []) if c in kinds and code not in kinds[c]["parents"]]
        problems += [f"{w}: называет родителем {p}, а в его children его нет" for p in k["parents"] if p in kinds and code not in kinds[p].get("children", [])]
        # Где создаёт оператор — внутри того, где вид живёт; capability create — ровно у тех, кого создают. create без
        # createParents — вид, который заводится только дочерней строкой нового родителя: он должен быть в чьих-то children
        create_parents = k.get("createParents") or []
        problems += [f"{w}: createParents {p} — нет в parents" for p in create_parents if p not in k["parents"]]
        creatable = "create" in k.get("capabilities", [])
        if create_parents and not creatable:
            problems.append(f"{w}: capability create не объявлена при createParents")
        if creatable and not create_parents and not any(code in x.get("children", []) for x in kinds.values()):
            problems.append(f"{w}: capability create без createParents и ни в чьих children")
        problems += [f"{w}: профиль {p} — нет такого" for p in k.get("implements", []) if p not in profiles]
        acc = k.get("access")
        for c in [acc] + acc.get("also", []) if acc else []:
            if c["class"] in levels and c["levels"] != levels[c["class"]]:
                problems.append(f"{w}: уровни класса {c['class']} не как в reference.access.levels")
        kind_schema_problems(spec, k["schema"], f"{w} schema", kinds, profiles, problems)
        if k["schema"].get("type") != "object":
            problems.append(f"{w}: схема — не type: object")
        for a in k.get("actions", []):
            for part in ("params", "result"):
                if part in a:
                    kind_schema_problems(spec, a[part], f"{w} действие {a['id']} {part}", kinds, profiles, problems)
            right_problem(k, a.get("right"), f"{w} действие {a['id']}")
        for e in k.get("events", []):
            if "params" in e:
                kind_schema_problems(spec, e["params"], f"{w} событие {e['id']} params", kinds, profiles, problems)
            right_problem(k, e.get("right"), f"{w} событие {e['id']}")
        for prof, r in (k.get("apiRights") or {}).items():
            if prof not in k.get("implements", []):
                problems.append(f"{w} apiRights {prof}: вид этот профиль не реализует")
            right_problem(k, r, f"{w} apiRights {prof}")
        # Коды уникальны в своём списке: событие и команда с одним кодом — разные вещи (у единицы СКУД и команда, и событие — unit)
        for part in ("actions", "events"):
            ids = [x["id"] for x in k.get(part, [])]
            if len(set(ids)) != len(ids):
                problems.append(f"{w}: id {'действий' if part == 'actions' else 'событий'} повторяются")
    implements = {code: set(k.get("implements", [])) for code, k in kinds.items()}
    # Свойство профиля — хотя бы у одного вида, объявившего профиль (вид несёт те, что у него есть)
    for pid, p in profiles.items():
        codes = [c for c, imp in implements.items() if pid in imp]
        if not codes:
            continue
        missing = [x for x in p.get("properties", []) if not any(x in kinds[c]["schema"].get("properties", {}) for c in codes)]
        if missing:
            problems.append(f"профиль {pid}: ни у одного вида нет свойств {', '.join(missing)}")
    rep.check(f"{label}: описания видов — схемы в подмножестве, родители и профили существуют", problems, f"{len(kinds)} видов")

    # Объекты: uid уникальны, вид описан, родитель из parents и того же домена, папки и секреты — свои
    problems = []
    units = {}
    for u in fx["units"]:
        if u["uid"] in units:
            problems.append(f"объект {u['uid']}: uid повторяется")
        units[u["uid"]] = u
    for u in fx["units"]:
        w = f"{u['kind']} {u['name']} ({u['uid']})"
        k = kinds.get(u["kind"])
        if not k:
            problems.append(f"{w}: вид не описан")
            continue
        parent = units.get(u["parentId"]) if u["parentId"] is not None else None
        if u["parentId"] is not None and parent is None:
            problems.append(f"{w}: нет родителя {u['parentId']}")
        elif (parent["kind"] if parent else None) not in k["parents"]:
            problems.append(f"{w}: родитель вида {parent['kind'] if parent else None} — не из parents {k['parents']}")
        elif parent and parent.get("domainId") != u.get("domainId") and parent["kind"] != "domain":
            problems.append(f"{w}: домен не как у родителя")
        dom = units.get(u.get("domainId"))
        if (u.get("domainId") is None) != (u["kind"] == "domain") or (u.get("domainId") is not None and (dom is None or dom["kind"] != "domain")):
            problems.append(f"{w}: домен {u.get('domainId')} — у домена null, у остальных — существующий домен")
        for f in u.get("folders", []):
            if (units.get(f) or {}).get("kind") != "folder" or units[f].get("domainId") != u.get("domainId"):
                problems.append(f"{w}: папка {f} — нет такой папки в его домене")
        props = k["schema"].get("properties", {})
        problems += [f"{w}: секрет {s} — нет writeOnly-свойства" for s in u.get("secrets", {}) if not props.get(s, {}).get("writeOnly")]
        unit_refs(k["schema"], u["properties"], f"{w} /properties", units, implements, problems)
    # Свойства по схеме вида — тем же ConsolemContract.validate, что у сервера; направление — ответ (секретов нет)
    script = (
        f"global.window=global;require('./{API}/contract.js');"
        "const fx=JSON.parse(require('fs').readFileSync(0,'utf8'));const K=new Map(fx.kinds.map((k)=>[k.kind,k]));const out=[];"
        "fx.units.forEach((u)=>{const k=K.get(u.kind);if(!k)return;"
        "window.ConsolemContract.validate(k.schema,u.properties,'/properties',{dir:'read'}).forEach((e)=>"
        "out.push(`${u.kind} ${u.name} (${u.uid}): ${e.field} — ${e.params.keyword}${e.params.allowed?' '+JSON.stringify(e.params.allowed):''}`))});"
        "console.log(JSON.stringify(out))"
    )
    res = subprocess.run(["node", "-e", script], input=json.dumps({"kinds": fx["kinds"], "units": fx["units"]}, ensure_ascii=False),
                         capture_output=True, text=True, cwd=ROOT)
    problems += res.stderr.strip().splitlines()[-3:] if res.returncode else json.loads(res.stdout)
    # status профиля — то, что объекты его видов действительно отдают в status.observed (или названное в PROFILE_STATUS_EXTRA).
    # Только у эталонного набора: one-domain и large — его отбор, части status в них может не быть
    observed = {}
    for u in fx["units"]:
        observed.setdefault(u["kind"], set()).update((u.get("status") or {}).get("observed", {}))
    for pid, p in (profiles.items() if label == "Эталонный набор" else ()):
        have = set().union(*(observed.get(c, set()) for c, imp in implements.items() if pid in imp)) | set(PROFILE_STATUS_EXTRA.get(pid, []))
        problems += [f"профиль {pid}: status {s} — нет в status.observed ни одного объекта его видов" for s in p.get("status", []) if s not in have]
    rep.check(f"{label}: объекты проходят схему своего вида, родители из parents, x-ref разрешаются", problems, f"{len(units)} объектов")

    # Ссылки остальных разделов: uid домена, сервера, устройства, папки, хранилища, тома ведут в объекты склада.
    # Старые разделы, пока они есть, повторяются складом с теми же id
    problems = []
    for key in ("rules", "ruleFires", "ruleVersions", "access", "archiveWatches", "archiveScans", "holds", "bookmarks", "journal",
                "maintenanceWindows", "discovery", "network", "relays"):
        seen = set()
        for m in UUID_ANY.finditer(json.dumps(fx.get(key), ensure_ascii=False)):
            uid = m.group(0)
            if uid[0] in UNIT_PREFIXES and uid not in units and uid not in seen:
                seen.add(uid)
                problems.append(f"{key}: {uid} — нет такого объекта")
    for key in OLD_UNIT_TABLES:
        problems += [f"{key}: {r['id']} ({r['name']}) — нет объекта с таким uid" for r in fx.get(key, []) if r["id"] not in units]
    rep.check(f"{label}: ссылки правил, прав, обходов, удержаний, отметок — на объекты склада", problems)


def rule_field_enum(fx, field):
    """Значения поля шага правила из каталога (с 0.31.0): enum у schema поля действия без объекта (reference.ruleActions)
    и у параметра команды правила вида (UnitKind.actions[].params)."""
    out = []
    for a in fx["reference"].get("ruleActions", []):
        out += [v for f in a.get("fields", []) if f.get("id") == field for v in (f.get("schema") or {}).get("enum", [])]
    for k in fx.get("kinds", []):
        for a in k.get("actions") or []:
            if a.get("ruleAction"):
                out += ((((a.get("params") or {}).get("properties") or {}).get(field)) or {}).get("enum", [])
    return out


def check_rule_catalog(rep, spec, fixtures):
    """Каталог правил (с 0.31.0): schema полей действий — в подмножестве схем видов; ruleChecks без повторов, implements —
    объявленные профили; areaLayouts — объявленные области и раскладки набора."""
    problems = []
    for name, fx in fixtures.items():
        ref = fx["reference"]
        kinds = {k["kind"] for k in fx.get("kinds", [])}
        profiles = {p for k in fx.get("kinds", []) for p in k.get("implements") or []}
        for a in ref.get("ruleActions", []):
            for f in a.get("fields", []):
                if "schema" in f:
                    kind_schema_problems(spec, f["schema"], f"{name}: ruleActions {a['source']}.{a['action']}.{f['id']}", kinds, profiles, problems)
        whats = [c["what"] for c in ref.get("ruleChecks", [])]
        problems += [f"{name}: ruleChecks {w} — повтор" for w in set(whats) if whats.count(w) > 1]
        for c in ref.get("ruleChecks", []) + ref.get("ruleConditions", []):
            problems += [f"{name}: {c.get('what') or c.get('kind')} — профиль {p} не объявлен видами" for p in c.get("implements") or [] if p not in profiles]
        on = ref.get("ruleTargets") or {}
        lays = {l["id"] for l in fx.get("layouts") or []}
        for area, lay in (on.get("areaLayouts") or {}).items():
            if area not in on.get("areas", []):
                problems.append(f"{name}: areaLayouts {area} — области нет в ruleTargets.areas")
            if lay not in lays:
                problems.append(f"{name}: areaLayouts {area} — раскладки {lay} нет в layouts")
    rep.check("Каталог правил: schema полей действий, ruleChecks, areaLayouts", problems,
              ", ".join(f"{n}: проверок {len(fx['reference'].get('ruleChecks', []))}" for n, fx in fixtures.items()))


def check_agents_mechanism(rep, spec, fx):
    """Набор agents (система не из мира VMS): объявлены только операции механизма — пути без x-layer; виды — без профилей слоёв,
    кроме профилей механизма core.domain/1 (область) и core.folder/1 (папка)."""
    op_layer = {}
    for path, item in spec["paths"].items():
        for method, o in item.items():
            if method in ("get", "post", "put", "patch", "delete") and "test-support" not in o.get("tags", []):
                op_layer[o["operationId"]] = layers.layer_of_path(spec, path)
    problems = [f"agents: операция {op} — слоя {op_layer[op]}" for op in fx["reference"]["capabilities"]["operations"] if op_layer.get(op) is not None]
    allowed = {"core.domain/1", "core.folder/1"}
    problems += [f"agents: вид {k['kind']} объявляет профиль {p}" for k in fx.get("kinds", []) for p in k.get("implements") or [] if p not in allowed]
    # Устаревшие справочники VMS в Reference (с 0.30.0 необязательны): у системы без VMS их нет
    ref_props = spec["components"]["schemas"]["Reference"]["properties"]
    old = [k for k, s in ref_props.items() if s.get("deprecated") and s.get("x-layer")]
    old_limits = [k for k, s in ref_props["limits"]["properties"].items() if s.get("deprecated") and s.get("x-layer")]
    problems += [f"agents: reference.{k} — справочник VMS" for k in old if k in fx["reference"]]
    problems += [f"agents: reference.limits.{k} — предел VMS" for k in old_limits if k in fx["reference"].get("limits", {})]
    # Каталог правил (с 0.31.0): условия и проверки — механизма или профилей механизма
    for c in fx["reference"].get("ruleConditions", []) + fx["reference"].get("ruleChecks", []):
        problems += [f"agents: правило {c.get('kind') or c.get('what')} — профиль {p}" for p in c.get("implements") or [] if p not in allowed]
    rep.check("agents: только операции механизма", problems, f"операций {len(fx['reference']['capabilities']['operations'])}")


def check_capabilities(rep, spec, fixtures):
    """Возможности системы в наборах: из контракта; эталонный — весь контракт; данные набора не
    противоречат объявленному (нет устройств неподдержанных видов, шифрования без archiveEncryption…)."""
    product = [o["operationId"] for item in spec["paths"].values() for m, o in item.items()
               if m in ("get", "post", "put", "patch", "delete") and "test-support" not in o.get("tags", [])]
    # Видов устройств в capabilities нет — какие виды есть у системы, говорит GET /kinds (раздел kinds)
    features = spec["components"]["schemas"]["Feature"]["enum"]
    problems = []
    for name, fx in fixtures.items():
        caps = fx["reference"]["capabilities"]
        ops = caps["operations"]
        declared = {k["kind"] for k in fx.get("kinds", [])}
        problems += [f"{name}: операции {o} нет в контракте или она служебная" for o in ops if o not in product]
        problems += [f"{name}: нет обязательной {o}" for o in ("getMe", "getReference", "stream") if o not in ops]
        if len(set(ops)) != len(ops):
            problems.append(f"{name}: операции повторяются")
        problems += [f"{name}: устройство {d['name']} вида {d['type']} — вид не объявлен" for d in fx["devices"] if d["type"] not in declared]
        problems += [f"{name}: объект {u['uid']} вида {u['kind']} — вида нет в kinds" for u in fx.get("units", []) if u["kind"] not in declared]
        if "archiveEncryption" not in caps["features"]:
            problems += [f"{name}: хранилище {a['name']} зашифровано без archiveEncryption" for a in fx["archives"] if a["encrypted"]]
        # Второй том хранилища и второй домен — POST /units видом с возможностью create
        # (UnitKind.capabilities тома, домена): без неё том бывает только первым, вместе с новым хранилищем
        def creates(profile):
            return "createUnits" in ops and any("create" in (k.get("capabilities") or []) for k in fx.get("kinds", []) if profile in (k.get("implements") or []))
        if not creates("vms.volume/1"):
            per = {}
            for v in fx["volumes"]:
                per[v["archiveId"]] = per.get(v["archiveId"], 0) + 1
            problems += [f"{name}: у хранилища {a} томов {n} без create у вида тома" for a, n in per.items() if n > 1]
        if "listLicenses" not in ops and fx["licenses"]:
            problems.append(f"{name}: лицензии без listLicenses")
        if "getDiscovery" not in ops and (fx["discovery"] or fx["network"]):
            problems.append(f"{name}: итоги поиска без getDiscovery")
        if not creates("core.domain/1") and len(fx["domains"]) > 1:
            problems.append(f"{name}: доменов {len(fx['domains'])} без create у вида домена")
    # Шаги ожидания оператора объявляются только вместе с дверью ответа
    for name, fx in fixtures.items():
        ops_ = fx["reference"]["capabilities"]["operations"]
        if any(c["control"] in ("ask", "escalate") for c in fx["reference"]["ruleControls"]) and not {"listRulePrompts", "answerRulePrompt"} <= set(ops_):
            problems.append(f"{name}: шаги ask, escalate объявлены без listRulePrompts, answerRulePrompt")
    demo = fixtures["demo"]["reference"]["capabilities"]
    stale = [k for k in ("deviceTypes", "foundDeviceTypes", "unitTypes", "writableFields") if k in demo]
    if stale:
        problems.append(f"demo: в capabilities есть {', '.join(stale)} — их заменяют описания видов")
    if {k: demo[k] for k in ("operations", "features")} != {"operations": product, "features": features}:
        problems.append("demo: возможности — не весь контракт: reference.capabilities.operations и features в demo.json — "
                        "все операции (кроме служебных) и все Feature контракта, в порядке контракта")
    rep.check("Возможности в наборах: из контракта, demo — весь контракт, данные не противоречат объявленному", problems,
              "; ".join(f"{n}: операций {len(f['reference']['capabilities']['operations'])}" for n, f in fixtures.items()))


# ===== 4–5. HTML прототипа =====

def check_prototype(rep):
    page = read(PROTOTYPE)
    if page is None:
        rep.fail("Прототип на месте", [f"нет {PROTOTYPE}"])
        return
    left = []
    stale = []
    for pattern, what in DATA_CONSTANTS.items():
        found = re.search(pattern, page)
        if found and pattern not in PENDING:
            left.append(f"{what}: {pattern}")
        if not found and pattern in PENDING:
            stale.append(f"{what}: константы уже нет — уберите {pattern!r} из PENDING")
    rep.check("В HTML прототипа нет констант-данных сервера, кроме ещё не переведённых", left + stale,
              f"ещё не переведено: {len(PENDING)} из {len(DATA_CONSTANTS)}")
    problems = []
    creates = len(re.findall(r"ConsolemServer\.create\(", page))
    if creates > 1:
        problems.append(f"ConsolemServer.create встречается {creates} раза: сервер создаётся один раз и уходит в клиент")
    if re.search(r"\.handle\(", page):
        problems.append("интерфейс вызывает server.handle напрямую — только через клиент API")
    rep.check("Интерфейс не трогает внутренности сервера", problems)


# ===== 6. Контракт ↔ сервер =====

def check_server(rep, spec):
    if read(f"{API}/server.js") is None:
        rep.info(f"{API}/server.js ещё нет — сверка маршрутов сервера с контрактом пропущена (этап 4)")
        return
    # Маршруты — у самого сервера: часть их собирается кодом, в тексте файла их не найти
    script = (
        f"global.window=global;require('./{API}/contract.js');require('./{API}/server.js');"
        f"const fx=require('./{API}/fixtures/demo.json');"
        "const s=window.ConsolemServer.create({fixture:fx,autoTick:false,testSupport:true});"
        "console.log(JSON.stringify(s.routes))"
    )
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True, cwd=ROOT)
    if res.returncode:
        rep.fail("Встроенный сервер запускается в Node", res.stderr.strip().splitlines()[-5:])
        return
    # Досылка потока после переподключения: по Last-Event-ID — пропущенное по порядку, по неизвестному — stream.reset.
    # Через браузер её не проверить (заголовок EventSource ставит сам при обрыве), поэтому — сервер напрямую
    stream = (
        f"global.window=global;require('./{API}/contract.js');require('./{API}/server.js');"
        f"const fx=require('./{API}/fixtures/demo.json');"
        "const s=window.ConsolemServer.create({fixture:fx,autoTick:false,testSupport:true});"
        "const d=window.ConsolemServer.legacyFixture(fx).devices[0];const got=[];const seen=f=>{const g=m=>{if(m.type==='stream.hello'){g.client=m.clientId;return}f(m)};return g};"
        "const w=seen(m=>got.push(m));s.subscribe(w);"
        "const P='/units/';let v=s.handle('GET',P+d.id).body.version;"
        "const h=n=>{v=s.handle('PATCH',P+d.id,{name:n},{'If-Match':'\"'+v+'\"'}).body.version};"
        "setTimeout(()=>{s.handle('PUT','/stream/'+w.client+'/watch',{ids:[d.id]});h('a');h('b');h('c');"
        "setTimeout(()=>{const first=got[0].id,missed=[],reset=[];"
        "s.subscribe(seen(m=>missed.push(m)),first);s.subscribe(seen(m=>reset.push(m)),'999999');"
        "setTimeout(()=>console.log(JSON.stringify({sent:got.map(m=>m.id),missed:missed.map(m=>m.id),reset:reset.map(m=>m.type)})),10)},10)},10)"
    )
    sres = subprocess.run(["node", "-e", stream], capture_output=True, text=True, cwd=ROOT)
    problems = []
    if sres.returncode:
        problems = sres.stderr.strip().splitlines()[-3:]
    else:
        r = json.loads(sres.stdout)
        if r["missed"] != r["sent"][1:]:
            problems.append(f"после Last-Event-ID={r['sent'][0]} дослано {r['missed']} вместо {r['sent'][1:]}")
        if r["reset"] != ["stream.reset"]:
            problems.append(f"по неизвестному Last-Event-ID пришло {r['reset']} вместо stream.reset")
    rep.check("Поток событий: досылка по Last-Event-ID, stream.reset при потере", problems)
    check_pages(rep, spec)
    bare = lambda p: re.sub(r"\{\w+\}", "{}", p)
    routes = {(r.split(" ", 1)[0], bare(r.split(" ", 1)[1])) for r in json.loads(res.stdout)}
    ops = {(m.upper(), bare(p)) for p, item in spec["paths"].items() for m in METHODS if m in item}
    problems = [f"{m} {p}: в контракте есть, в server.js нет" for m, p in sorted(ops - routes)]
    problems += [f"{m} {p}: в server.js есть, в контракте нет" for m, p in sorted(routes - ops)]
    rep.check("Каждая операция контракта реализована в server.js, каждый маршрут описан в контракте", problems, f"{len(ops)} операций")


# ===== 7. Памятка =====

# Перечни таблицы контракта: у каждого limit и cursor, ответ {items, nextCursor?, total?} — и так же ведёт себя сервер.
# Перечни объектов — /units, предметные API — по uid
PAGED = ["/units", "/journal", "/operations", "/rules/{ruleId}/fires", "/archive-watches", "/archive-scans",
         "/access/users", "/access/groups", "/access/history", "/access/cell-history", "/access/roles/{roleId}/objects", "/tree/children", "/units/{uid}/discovery",
         "/units/{uid}/timeline", "/units/{uid}/holds", "/units/{uid}/bookmarks"]


def check_pages(rep, spec):
    problems = []
    for path in PAGED:
        op = spec["paths"][path]["get"]
        names = {p["name"] for p in op.get("parameters", [])}
        if not {"limit", "cursor"} <= names:
            problems.append(f"{path}: нет limit или cursor")
        schema = op["responses"]["200"]["content"]["application/json"]["schema"]
        if "$ref" in schema:
            schema = spec["components"]["schemas"][schema["$ref"].split("/")[-1]]
        if "nextCursor" not in schema["properties"]:
            problems.append(f"{path}: в ответе нет nextCursor")
    res = subprocess.run(["node", os.path.join(ROOT, "tools", "check_pages.js"), API], capture_output=True, text=True, cwd=ROOT)
    problems += res.stderr.strip().splitlines()[-3:] if res.returncode else json.loads(res.stdout)
    rep.check("Общее правило страницы: каждый перечень, пустая страница, обе формы version", problems, f"{len(PAGED)} перечней")


# ===== Протокол своей страницы setup/1 (api/SETUP-UI.md, api/setup-ui.schema.json) =====
# Разрешённые ключевые слова схемы сообщений: то, что понимают validate выше и ConsolemContract.check (api/contract.js),
# плюс служебные слова корня и $defs. Список разрешённый, а не запретный: незнакомое слово — отказ, а не молчаливый пропуск
SETUP_UI_KEYWORDS = {"type", "properties", "required", "additionalProperties", "items", "enum", "$ref", "oneOf", "anyOf", "format",
                     "minimum", "maximum", "pattern", "minLength", "maxLength", "minItems", "maxItems", "description",
                     "$schema", "$id", "$defs", "title", "examples", "x-direction", "x-step"}
SETUP_UI_DIRECTIONS = {"toPage": "→ страница", "toHost": "→ consolem"}


def setup_ui_problems(spec, schema, doc):
    """Расхождения схемы сообщений setup/1 с собой, с описанием SETUP-UI.md и с Problem контракта (список строк).
    Кривой вход (не тот тип у $defs, properties, oneOf, x-step…) — отказ строкой, а не исключение."""
    if not isinstance(schema, dict):
        return ["#: схема — не объект"], 0
    problems = []
    defs = schema.get("$defs")
    if not isinstance(defs, dict):
        problems.append("#/$defs: не объект")
        defs = {}
    bad_refs = []
    obj = lambda v: v if isinstance(v, dict) else {}

    def walk(node, where):
        if not isinstance(node, dict):
            problems.append(f"{where}: схема — не объект")
            return
        problems.extend(f"{where}: {k} — вне разрешённых ключевых слов" for k in sorted(map(str, node)) if k not in SETUP_UI_KEYWORDS)
        ref = node.get("$ref")
        if ref is not None and not (isinstance(ref, str) and re.fullmatch(r"#/\$defs/\w+", ref) and ref.split("/")[-1] in defs):
            bad_refs.append(ref)
            problems.append(f"{where}: ссылка {ref} — только на #/$defs/<имя> этого файла")
        for key in ("properties", "$defs"):
            sub = node.get(key)
            if sub is not None and not isinstance(sub, dict):
                problems.append(f"{where}/{key}: не объект")
                continue
            for name, one in (sub or {}).items():
                walk(one, f"{where}/{key}/{name}")
        for key in ("items", "additionalProperties"):
            if isinstance(node.get(key), dict):
                walk(node[key], f"{where}/{key}")
            elif key in node and not isinstance(node[key], bool):
                problems.append(f"{where}/{key}: не схема и не true/false")
        for key in ("oneOf", "anyOf"):
            sub = node.get(key)
            if sub is not None and not isinstance(sub, list):
                problems.append(f"{where}/{key}: не список")
                continue
            for i, one in enumerate(sub or []):
                walk(one, f"{where}/{key}/{i}")
        for key in ("required", "enum"):
            if key in node and not isinstance(node[key], list):
                problems.append(f"{where}/{key}: не список")

    walk(schema, "#")
    # Сообщения — $defs с x-direction; корень перечисляет в oneOf ровно их
    messages = {n: d for n, d in defs.items() if isinstance(d, dict) and "x-direction" in d}
    one_of = schema.get("oneOf") if isinstance(schema.get("oneOf"), list) else []
    listed = {s["$ref"].split("/")[-1] for s in one_of if isinstance(s, dict) and isinstance(s.get("$ref"), str)}
    problems.extend(f"#/oneOf: нет сообщения {n}" for n in sorted(set(messages) - listed))
    problems.extend(f"#/oneOf: {n} — не сообщение (у $defs нет x-direction)" for n in sorted(listed - set(messages)))
    for name, d in messages.items():
        where = f"#/$defs/{name}"
        if not isinstance(d["x-direction"], str) or d["x-direction"] not in SETUP_UI_DIRECTIONS:
            problems.append(f"{where}: x-direction {d['x-direction']!r} — не toPage и не toHost")
        step = d.get("x-step")
        if not isinstance(step, int) or isinstance(step, bool):
            problems.append(f"{where}: x-step {step!r} — нужно целое число" if "x-step" in d else f"{where}: нет x-step")
        required = d.get("required") if isinstance(d.get("required"), list) else []
        if not {"proto", "type"} <= {r for r in required if isinstance(r, str)}:
            problems.append(f"{where}: proto и type не в required")
        props = obj(d.get("properties"))
        if obj(props.get("proto")).get("enum") != ["setup/1"]:
            problems.append(f"{where}: proto — не enum [\"setup/1\"]")
        if obj(props.get("type")).get("enum") != [name]:
            problems.append(f"{where}: type — не enum [\"{name}\"]")
        if d.get("additionalProperties") is not False:
            problems.append(f"{where}: нет additionalProperties: false")
    # Примеры: у каждого сообщения есть, каждый проходит схему своего type (с битой ссылкой схему не прогнать)
    shape = {"components": {"schemas": defs}}
    seen = set()
    examples = schema.get("examples", [])
    if not isinstance(examples, list):
        problems.append("#/examples: не список")
        examples = []
    for i, ex in enumerate(examples):
        t = ex.get("type") if isinstance(ex, dict) else None
        if not isinstance(t, str) or t not in messages:
            problems.append(f"#/examples/{i}: нет сообщения type {t!r}")
            continue
        seen.add(t)
        if not bad_refs:
            try:
                validate(shape, messages[t], ex, f"#/examples/{i} ({t})", problems)
            except Exception as e:  # кривая схема сообщения: причина уже в problems выше, пример не прогнать
                problems.append(f"#/examples/{i} ({t}): схему не прогнать — {type(e).__name__}: {e}")
    problems.extend(f"#/$defs/{n}: нет примера в examples" for n in sorted(set(messages) - seen))
    # Таблицы «Сообщения» описания: строка на сообщение, направление — по заголовку таблицы
    sec = re.search(r"^## Сообщения\s*$(.*?)(?=^## )", doc + "\n## ", re.S | re.M)
    rows = {}
    if not sec:
        problems.append("SETUP-UI.md: нет раздела «## Сообщения»")
    else:
        direction = None
        for line in sec.group(1).splitlines():
            if line.startswith("### "):
                direction = next((k for k, v in SETUP_UI_DIRECTIONS.items() if v in line), None)
                if direction is None:
                    problems.append(f"SETUP-UI.md: «{line[4:]}» — заголовок таблицы без «→ страница» или «→ consolem»")
                continue
            m = re.match(r"\|\s*`(\w+)`\s*\|\s*([^|]*)\|", line)
            if not m or m.group(2).strip() == "Когда":  # строка заголовка таблицы
                continue
            if m.group(1) in rows:
                problems.append(f"SETUP-UI.md: сообщение {m.group(1)} — в таблицах дважды")
            rows[m.group(1)] = direction
    for n, direction in rows.items():
        if n not in messages:
            problems.append(f"SETUP-UI.md: сообщение {n} — нет в $defs")
        elif messages[n]["x-direction"] != direction:
            problems.append(f"SETUP-UI.md: сообщение {n} — в таблице {direction}, в схеме {messages[n]['x-direction']}")
    problems.extend(f"SETUP-UI.md: сообщения {n} нет в таблицах «Сообщения»" for n in sorted(set(messages) - set(rows)) if sec)
    # problem и problemError — копии Problem и ProblemError контракта
    schemas = spec["components"]["schemas"]
    for mine, theirs in (("problem", "Problem"), ("problemError", "ProblemError")):
        a, b = defs.get(mine), schemas.get(theirs) or {}
        if not isinstance(a, dict):
            problems.append(f"#/$defs/{mine}: нет копии {theirs}")
            continue
        if set(obj(a.get("properties"))) != set(b.get("properties") or {}):
            problems.append(f"#/$defs/{mine}: поля {sorted(obj(a.get('properties')))} — у {theirs} {sorted(b.get('properties') or {})}")
        req = sorted(map(str, a.get("required") if isinstance(a.get("required"), list) else []))
        if req != sorted(b.get("required") or []):
            problems.append(f"#/$defs/{mine}: required {req} — у {theirs} {sorted(b.get('required') or [])}")
    setup = schemas.get("UnitKind", {}).get("properties", {}).get("setupUi", {})
    if "api/SETUP-UI.md" not in setup.get("description", ""):
        problems.append("openapi.json: в описании UnitKind.setupUi нет ссылки на api/SETUP-UI.md")
    return problems, len(messages)


def check_setup_ui(rep, spec):
    name = "Протокол страницы setup/1: схема сообщений, примеры, описание"
    missing = [f"файла {API}/{f} нет" for f in ("setup-ui.schema.json", "SETUP-UI.md") if read(f"{API}/{f}") is None]
    if missing:
        return rep.check(name, missing)
    try:
        schema = json.loads(read(f"{API}/setup-ui.schema.json"))
    except ValueError as e:
        return rep.check(name, [f"{API}/setup-ui.schema.json: не JSON — {e}"])
    problems, n = setup_ui_problems(spec, schema, read(f"{API}/SETUP-UI.md"))
    rep.check(name, problems, f"{n} сообщений")
    # Библиотека автора страницы: протокол в Node на поддельном окне, каждое её сообщение — по схеме (tools/check_setup_bridge.js)
    name = "Библиотека страницы setup-bridge.js: протокол setup/1"
    if read(f"{API}/setup-bridge.js") is None:
        return rep.fail(name, [f"{API}/setup-bridge.js нет"])
    problems, note = setup_bridge_run()
    rep.check(name, problems, note)


def setup_bridge_run():
    """Прогон tools/check_setup_bridge.js в Node → (отказы, итог). Скрипт печатает {"problems": […], "scenarios": N}.
    Нет node, выход не 0 или вывод не тот — отказ строкой, а не исключение."""
    try:
        res = subprocess.run(["node", os.path.join(ROOT, "tools", "check_setup_bridge.js"), API], capture_output=True, text=True, cwd=ROOT)
    except OSError as e:
        return [f"node не запустился: {e}"], ""
    if res.returncode:
        return res.stderr.strip().splitlines()[-3:] or [f"check_setup_bridge.js: exit code {res.returncode}"], ""
    try:
        out = json.loads(res.stdout)
    except ValueError:
        return [f"check_setup_bridge.js: не JSON — {res.stdout.strip()[-200:]}"], ""
    problems = out.get("problems") if isinstance(out, dict) else None
    count = out.get("scenarios") if isinstance(out, dict) else None
    if not isinstance(problems, list) or not isinstance(count, int) or isinstance(count, bool):
        return [f"check_setup_bridge.js: вывод не {{problems: […], scenarios: N}} — {res.stdout.strip()[-200:]}"], ""
    return [str(p) for p in problems], f"сценариев {count}"


def check_core_field(rep, spec):
    # Пути ядра (/kinds…, /units…): field отказа в описаниях — только JSON Pointer (запрос w2c 2026-11-05-100905Z)
    problems, n = [], 0
    def walk(node, where, query=()):
        nonlocal n
        if isinstance(node, dict):
            for k, v in node.items():
                if k in ("description", "summary") and isinstance(v, str):
                    for m in re.finditer(r"\bfield:\s*`?([^\s`,.;)]+)", v):
                        n += 1
                        if not m.group(1).startswith("/") and m.group(1) not in query:
                            problems.append(f"{where}: field {m.group(1)} — нужен указатель /…")
                else:
                    walk(v, where, query)
        elif isinstance(node, list):
            for v in node:
                walk(v, where, query)
    for path, item in spec["paths"].items():
        if path.startswith(("/kinds", "/units")):
            for method, op in item.items():
                # параметр адреса (?noDetector=…) — не тело: его field остаётся именем
                query = {p.get("name") for p in op.get("parameters", []) if isinstance(p, dict)} if isinstance(op, dict) else set()
                walk(op, f"{method.upper()} {path}", query)
    rep.check("Пути ядра: field отказа в описаниях — JSON Pointer", problems, f"{n} упоминаний")


PROFILES_BASE = cli_paths.opt("profiles-base", "origin/main")


def check_profile_files(rep, spec, fixtures):
    """Профили в файлах api/profiles/*.json (tools/profile_files.py): формат; раздел profiles наборов — из файлов;
    виды несут поля профиля того же типа, status объектов — по схеме профиля; версия против PROFILES_BASE; зависимости uses."""
    folder = os.path.join(ROOT, API, profile_files.PROFILES_DIR)
    if not os.path.isdir(folder):
        rep.fail("Профили api/profiles/: файлы по формату", [f"нет папки {API}/profiles"])
        return
    try:
        docs = profile_files.load_profiles(os.path.join(ROOT, API))
    except ValueError as e:
        rep.fail("Профили api/profiles/: файлы по формату", [str(e)])
        return
    problems = [f"{d['_file']}: {t}" for d in docs for t in profile_files.profile_problems(d)]
    rep.check("Профили api/profiles/: файлы по формату", problems, f"файлов {len(docs)}")
    problems = []
    for name, fx in fixtures.items():
        problems += [f"набор {name}: {t}" for t in profile_files.fixture_profile_problems(fx.get("profiles") or [], docs, name == "demo")]
    rep.check("Профили: раздел profiles наборов — из файлов", problems)
    problems = []
    for name, fx in fixtures.items():
        problems += [f"набор {name}: {t}" for t in profile_files.kind_problems(docs, fx.get("kinds") or [], name != "demo", {k["kind"] for k in fx.get("kinds") or []})]
    # status.observed объектов эталонного набора — по схеме профиля (имя состояния → schema)
    demo = fixtures.get("demo") or {}
    kinds = {k["kind"]: k for k in demo.get("kinds") or []}
    schemas = {d["id"]: {n: f["schema"] for n, f in (d.get("status") or {}).items()} for d in docs}
    for u in demo.get("units") or []:
        obs = (u.get("status") or {}).get("observed") or {}
        for pid in (kinds.get(u.get("kind")) or {}).get("implements") or []:
            for n, sch in (schemas.get(pid) or {}).items():
                if n in obs:
                    out = []
                    validate(spec, sch, obs[n], f"{u['uid']} status.observed.{n}", out)
                    problems += [f"набор demo: {pid}: {t}" for t in out]
    rep.check("Профили: виды несут поля профиля того же типа; status объектов — по схеме профиля", problems)
    name = f"Профили: версия против {PROFILES_BASE}"
    if API != "api":
        rep.info(f"{name}: {API} — копия папки API, сверка с git пропущена")
    else:
        mb = layers.merge_base(PROFILES_BASE, ROOT, None)
        if mb is None:
            rep.info(f"{name}: нет git или {PROFILES_BASE}, сверка пропущена")
        else:
            problems = []
            for d in docs:
                text = layers.git_out(ROOT, "show", f"{mb}:{API}/profiles/{d['_file']}")
                try:
                    base = json.loads(text) if text else None
                except ValueError:
                    base = None
                problems += [f"{d['_file']}: {t}" for t in profile_files.history_problems(d, base)]
            listing = layers.git_out(ROOT, "ls-tree", "--name-only", mb, f"{API}/profiles/") or ""
            base_names = [os.path.basename(x) for x in listing.split("\n") if x.endswith(".json")]
            problems += profile_files.removed_file_problems(base_names, [d["_file"] for d in docs])
            rep.check(name, problems)
    rep.check("Профили: зависимости uses есть и не младше", profile_files.uses_problems(docs))


def check_layers(rep, spec):
    """Граница слоёв: правила S1–S5 в tools/layers.py."""
    try:
        problems = layers.static_problems(spec, layers.profile_ids(API))
    except ValueError as e:  # сломанный файл профиля
        rep.fail("Граница слоёв: поля подсистем в общих схемах", [str(e)])
        return
    schemas = [n for n in spec["components"]["schemas"] if layers.layer_of_schema(spec, n)]
    paths = [p for p in spec["paths"] if layers.layer_of_path(spec, p)]
    leaks = layers.leak_marks(spec)
    rep.check("Граница слоёв: поля подсистем в общих схемах", problems,
              f"{len(schemas)} схем, {len(paths)} путей подсистем, {len(leaks)} полей подсистем в общих схемах")


def check_mechanism(rep, spec, fixtures):
    """Механизм без VMS (tools/mechanism.py): раскладки наборов сходятся с их видами (L1–L7), разделы приложения (S1–S4), описания дерева — без слов VMS (B5)."""
    problems = [p for name, fx in fixtures.items() for p in mechanism.layout_problems(fx, name)]
    rep.check("Раскладки дерева в наборах: объявления сходятся с видами", problems,
              ", ".join(f"{name}: {len(fx.get('layouts') or [])}" for name, fx in fixtures.items()))
    problems = [p for name, fx in fixtures.items() for p in mechanism.section_problems(fx, name)]
    rep.check("Разделы приложения в наборах: объявлены с операциями, demo — все коды", problems,
              ", ".join(f"{name}: {len(((fx.get('reference') or {}).get('capabilities') or {}).get('sections') or [])}" for name, fx in fixtures.items()))
    rep.check("Граница механизма: без VMS в общих описаниях", mechanism.border_problems(spec),
              f"схем {len(mechanism.TREE_SCHEMAS)} и пути {mechanism.TREE_PATH_PREFIX}*")


def check_versions_by_layer(rep, spec):
    """Таблица docs/contract-layers/versions-by-layer.md: строка у каждой версии README и у текущей, слои знакомые."""
    name = "Версии контракта по слоям"
    path = os.path.join(ROOT, "docs", "contract-layers", "versions-by-layer.md")  # от корня репозитория, не от --api
    if not os.path.exists(path):
        rep.fail(name, ["нет файла docs/contract-layers/versions-by-layer.md"])
        return
    with open(path, encoding="utf-8") as f:
        table = f.read()
    try:
        ids = layers.profile_ids(API)
    except ValueError as e:  # сломанный файл профиля
        rep.fail(name, [str(e)])
        return
    problems = layers.versions_table_problems(read(f"{API}/README.md") or "", table, spec["info"]["version"], ids)
    rep.check(name, problems, f"текущая версия {spec['info']['version']}")


def check_layer_diff(rep, spec):
    """Слои правки против origin/main (tools/layers.py): какие слои задела правка, кого уведомить; механизм без новой версии — отказ."""
    name = "Слои правки против origin/main"
    if API != "api":
        rep.info(f"{name}: {API} — копия папки API, сверка с git пропущена")
        return
    try:
        cls = layers.classify("origin/main", ROOT, API)
    except ValueError as e:  # сломанный файл профиля
        rep.fail(name, [str(e)])
        return
    if cls is None:
        rep.info(f"{name}: нет git или origin/main, пропуск")
        return
    folder = os.path.join(ROOT, API, "profiles")
    active = os.path.isdir(folder) and any(n.endswith(".json") for n in os.listdir(folder))
    rep.info(f"{name}: файлов {len(cls['files'])}, {layers.version_text(cls)}, механизм {len(cls['mechanism'])}, "
             f"описаний {len(cls['descriptions'])}, пометок {len(cls['marks'])}")
    for text in cls["marks"][:5]:
        rep.info(f"{name}: пометка x-layer изменена у {text}")
    if len(cls["marks"]) > 5:
        rep.info(f"{name}: … и ещё {len(cls['marks']) - 5} пометок x-layer")
    for layer, items in cls["layers"].items():
        rep.info(f"{name}: слой {layer} — {len(items)}")
    for who, what in cls["notify"].items():
        rep.info(f"{name}: уведомить {who} ({', '.join(what)})")
    for note in layers.version_notes(cls):
        rep.info(f"{name}: {note}")
    rep.check(name, layers.version_problems(cls, active))


def check_backend_doc(rep, spec):
    doc = read(f"{API}/BACKEND.md")
    if doc is None:
        rep.info(f"{API}/BACKEND.md ещё нет — сверка чисел пропущена (этап 7)")
        return
    ops = [(p, m, item[m]) for p, item in spec["paths"].items() for m in METHODS if m in item]
    test = sum(1 for _, _, o in ops if "test-support" in o.get("tags", []))
    main = len(ops) - test
    problems = []
    m = re.search(r"(\d+)\s+операци\w*[^\n]*?(\d+)\s+служебн", doc)
    if not m:
        problems.append("не найдено «N операций … M служебных»")
    else:
        if int(m.group(1)) != main:
            problems.append(f"операций: в памятке {m.group(1)}, в контракте {main}")
        if int(m.group(2)) != test:
            problems.append(f"служебных: в памятке {m.group(2)}, в контракте {test}")
    rep.check("Числа в BACKEND.md совпадают с контрактом", problems, f"{main} + {test}")


# Контракт старого макета (типизированные пути /devices, /servers…): последний коммит, где он был в api/openapi.json
OLD_CONTRACT = ("47d1310", "api/openapi.json")
BREAKING_TITLE = "Ломающие изменения против контракта старого макета (до 0.2.0, коммит 47d1310)"


def old_contract():
    """Контракт старого макета из истории git; None — git недоступен или коммита в истории нет (мелкий клон)."""
    try:
        res = subprocess.run(["git", "show", ":".join(OLD_CONTRACT)], capture_output=True, text=True, cwd=ROOT, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode:
        return None
    try:
        return json.loads(res.stdout)
    except ValueError:
        return None


def schema_removed(a, b, path):
    """Что снято в схеме b против a, вглубь: поля (properties), значения перечня (enum), то же у items и additionalProperties.
    Ссылки $ref не раскрываются: схема по ссылке сверяется своей строкой. Ответ — пути вида «Схема.поле.подполе»."""
    if not isinstance(a, dict) or not isinstance(b, dict) or "$ref" in a or "$ref" in b:
        return []
    out = []
    pa, pb = a.get("properties") or {}, b.get("properties") or {}
    out += [f"{path}.{k}" for k in sorted(set(pa) - set(pb))]
    ea, eb = a.get("enum") or [], b.get("enum") or []
    out += [f"{path}={v!r}" for v in ea if v not in eb]
    for k in sorted(set(pa) & set(pb)):
        out += schema_removed(pa[k], pb[k], f"{path}.{k}")
    for key, mark in (("items", "[]"), ("additionalProperties", "{}")):
        out += schema_removed(a.get(key), b.get(key), path + mark)
    return out


def check_breaking_doc(rep, spec):
    """Контракт против контракта старого макета (git show 47d1310:api/openapi.json): каждая операция старого контракта, которой
    в нынешнем нет, и каждая снятая или изменённая (состав полей, перечень) схема названы в разделе README BREAKING_TITLE или в разделе
    «Ломающие изменения в X.Y.Z» (снятое после 0.2.0)."""
    base = old_contract()
    if base is None:
        rep.info(f"{BREAKING_TITLE}: контракта {':'.join(OLD_CONTRACT)} не прочитать (нет git или коммита в истории) — сверка пропущена")
        return
    doc = read(f"{API}/README.md") or ""
    m = re.search(r"^## " + re.escape(BREAKING_TITLE) + r"\n(.*?)(?=^## )", doc, re.S | re.M)
    if not m:
        rep.fail(f"{BREAKING_TITLE} — в README", [f"нет раздела «## {BREAKING_TITLE}»"])
        return
    text = m.group(1)
    # Позже снятое или изменённое владелец называет в своём разделе «Ломающие изменения в X.Y.Z»: старый раздел не дополняют
    later = "".join(re.findall(r"^## Ломающие изменения в \d+\.\d+\.\d+\n(.*?)(?=^## )", doc, re.S | re.M))
    named = set(re.findall(r"`([^`]+)`", text + later))
    def ops(d):
        return {o["operationId"] for item in d["paths"].values() for k, o in item.items() if k in METHODS}
    problems = [f"операция старого контракта {o} — нет в разделе" for o in sorted(ops(base) - ops(spec)) if o not in named]
    sa, sb = base["components"]["schemas"], spec["components"]["schemas"]
    problems += [f"схема старого контракта {n} снята — нет в разделе" for n in sorted(set(sa) - set(sb)) if n not in named]
    for n in sorted(set(sa) & set(sb)):
        gone = schema_removed(sa[n], sb[n], n)
        if gone and n not in named:
            more = f" и ещё {len(gone) - 3}" if len(gone) > 3 else ""
            problems.append(f"схема {n} изменена (снято: {', '.join(gone[:3])}{more}) — нет в разделе")
    if base["info"]["version"] == spec["info"]["version"]:
        problems.append(f"info.version тот же, что у старого контракта ({base['info']['version']}): несовместимый контракт — новая версия")
    rep.check("Ломающие изменения против контракта старого макета названы в README", problems,
              f"операций старого контракта снято {len(ops(base) - ops(spec))}, схем снято {len(set(sa) - set(sb))}")


LAYER_FORM = re.compile(r"^(mechanism|video|profile:[A-Za-z0-9_.-]+/[0-9]+)$")
SINCE_FORM = re.compile(r"^[0-9]+\.[0-9]+$")
# условия needs, которые связывают тест с видом или профилем набора (часть 04 переносит такие тесты в слой профиля)
KIND_NEEDS = ("kind:", "type:", "prop:", "cap:", "under:", "implements:")


def check_test_layers(rep, tests=TESTS, api=API):
    """У каждого теста API есть слой верной формы; слой профиля — id из файла api/profiles/; since — по версии профиля.
    Реестр тестов — tools/api_tests_registry.mjs (без запуска тестов). Разбор id и версии — profile_files, путь — layers."""
    name = "Слой у каждого теста API"
    res = subprocess.run(["node", os.path.join(ROOT, "tools", "api_tests_registry.mjs"), "--api", api, "--tests", tests],
                         capture_output=True, text=True, cwd=ROOT)
    if res.returncode != 0:
        rep.fail(name, ["реестр тестов не напечатан: " + (res.stderr.strip() or f"код {res.returncode}")])
        return
    reg = json.loads(res.stdout)
    problems = []
    versions = {}  # id профиля → версия из файла (None — файла нет или он не читается)

    def profile_version(pid):
        if pid not in versions:
            path = os.path.join(ROOT, layers.profile_file(pid, api))
            try:
                doc = json.load(open(path, encoding="utf-8"))
            except (OSError, ValueError):
                doc = None
            versions[pid] = doc if isinstance(doc, dict) and doc.get("id") == pid else None
            if doc is None:
                versions[pid] = "no-file"
        return versions[pid]

    count = {"mechanism": 0, "video": 0}
    profiles_used = set()
    for file, layer in sorted(reg["files"].items()):
        if not layer:
            problems.append(f"{file}: у файла нет слоя (ApiTest.fileLayer)")
    for t in reg["tests"]:
        where = f"{t['file']}.js «{t['name'][:60]}»"
        layer, since = t["layer"], t["since"]
        if not layer:
            problems.append(f"{where}: тест без слоя")
            continue
        if not LAYER_FORM.match(layer):
            problems.append(f"{where}: неизвестный слой «{layer}» (mechanism, video или profile:<id>/N)")
            continue
        if layer in count:
            count[layer] += 1
            if since is not None:
                problems.append(f"{where}: since — только у теста профиля, а слой — {layer}")
            continue
        pid = layer[len("profile:"):]
        profiles_used.add(pid)
        doc = profile_version(pid)
        if doc == "no-file" or doc is None:
            fname = layers.profile_file(pid, api)
            problems.append(f"{where}: нет файла профиля {fname}" if doc == "no-file" else f"{where}: id в {layers.profile_file(pid, api)} не {pid}")
            continue
        if since is None:
            continue
        try:
            sv = profile_files.parse_version(since)
        except ValueError:
            problems.append(f"{where}: since — вида M.m, а не «{since}»")
            continue
        if sv[0] != profile_files.major_of(pid):
            problems.append(f"{where}: старшая версия since не совпадает с /{profile_files.major_of(pid)}: «{since}»")
        try:
            cur = profile_files.parse_version(doc.get("version"))
        except ValueError:
            problems.append(f"{where}: в {layers.profile_file(pid, api)} version не вида M.m")
            continue
        if sv > cur:
            problems.append(f"{where}: since «{since}» старше версии профиля {doc.get('version')}")
    profile_tests = sum(1 for t in reg["tests"] if t["layer"] and t["layer"].startswith("profile:"))
    note = f"механизм {count['mechanism']}, API видео {count['video']}, профилей {len(profiles_used)} ({profile_tests} тестов)"
    rep.check(name, problems, note)
    if problems:
        return
    known = {}
    for t in reg["tests"]:
        if t["layer"] != "mechanism":
            continue
        hits = [n for n in t["needs"] if n.startswith(KIND_NEEDS) and not n.split(":", 1)[1].startswith("test.")]
        if hits:
            known[t["file"] + ".js"] = known.get(t["file"] + ".js", 0) + 1
    if known:
        rep.info(f"Тесты механизма на видах набора: {sum(known.values())} — "
                 + ", ".join(f"{f}: {n}" for f, n in sorted(known.items())))
    tested = set(profiles_used)
    for t in reg["tests"]:
        tested.update(n[len("implements:"):] for n in t["needs"] if n.startswith("implements:"))
    folder = os.path.join(ROOT, api, "profiles")
    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    ids = [i for i in (profile_files.id_of_file(n) for n in names) if i]
    untested = [i for i in ids if i not in tested]
    if untested:
        rep.info("Профили без тестов: " + ", ".join(untested))


def main():
    rep = Report()
    spec = load(f"{API}/openapi.json")
    # Набор хранит только units: старые разделы для проверок записей и ссылок выводятся из units тем же мостом,
    # что у сервера и profile_fixture.py (tools/generic_legacy.py)
    from generic_legacy import with_tables
    fx = with_tables(load(f"{API}/fixtures/demo.json"))
    profile = with_tables(load(f"{API}/fixtures/one-domain.json"))
    large = with_tables(load(f"{API}/fixtures/large.json"))
    agents = with_tables(load(f"{API}/fixtures/agents.json"))
    check_contract(rep, spec)
    check_bridge(rep, bridge_specs())
    check_fixture(rep, spec, fx)
    check_fixture(rep, spec, profile, "Набор one-domain")
    check_fixture(rep, spec, large, "Набор large")
    check_fixture(rep, spec, agents, "Набор agents")
    check_units(rep, spec, fx)
    check_units(rep, spec, profile, "Набор one-domain")
    check_units(rep, spec, large, "Набор large")
    check_units(rep, spec, agents, "Набор agents")
    check_capabilities(rep, spec, {"demo": fx, "one-domain": profile, "large": large, "agents": agents})
    check_agents_mechanism(rep, spec, agents)
    check_rule_catalog(rep, spec, {"demo": fx, "one-domain": profile, "large": large, "agents": agents})
    check_profile_files(rep, spec, {"demo": fx, "one-domain": profile, "large": large, "agents": agents})
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "profile_fixture.py"), "--check", "--api", API], capture_output=True, text=True)
    rep.check("one-domain.json собран из нынешнего demo.json", [l for l in res.stdout.splitlines() if l] if res.returncode else [])
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_api.py"), "--check", "--api", API], capture_output=True, text=True)
    rep.check("openapi.js и fixture.js собраны из нынешних JSON", [l for l in res.stdout.splitlines() if l] if res.returncode else [])
    check_prototype(rep)
    check_server(rep, spec)
    check_test_layers(rep)
    check_core_field(rep, spec)
    check_setup_ui(rep, spec)
    check_layers(rep, spec)
    check_mechanism(rep, spec, {"demo": fx, "one-domain": profile, "large": large, "agents": agents})
    check_versions_by_layer(rep, spec)
    check_backend_doc(rep, spec)
    check_breaking_doc(rep, spec)
    check_layer_diff(rep, spec)
    if "--lint" in sys.argv[1:]:
        res = subprocess.run(["npx", "-y", "@redocly/cli@1.34.0", "lint", os.path.join(ROOT, API, "openapi.json")],
                             capture_output=True, text=True, cwd=ROOT)
        tail = (res.stdout + res.stderr).strip().splitlines()[-3:]
        rep.check(f"redocly lint {API}/openapi.json", tail if res.returncode else [], tail[-1] if tail else "")
    print(f"RESULT {'fail' if rep.failed else 'pass'}")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
