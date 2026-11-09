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
С --lint дополнительно: npx @redocly/cli lint api/openapi.json.

Запуск из корня репозитория: python3 tools/check_api.py [--lint] [--api DIR] [--page FILE]
(--page — прототип вместо index.html; --api — копия папки API вместо api; в документе выше пути даны для умолчаний)
Код выхода 1, если что-то не прошло.
"""
import json
import os
import re
import subprocess
import sys

import cli_paths
import generic_legacy

API = cli_paths.opt("api", "api")
PROTOTYPE = cli_paths.opt("page", "index.html")
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
    if k in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"]:
            out.append(f"{where}: {value} меньше {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            out.append(f"{where}: {value} больше {schema['maximum']}")
    if k == "array" and "minItems" in schema and len(value) < schema["minItems"]:
        out.append(f"{where}: меньше {schema['minItems']} элементов")
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


# ===== 2. Эталонный набор =====

def check_fixture(rep, spec, fx, label="Эталонный набор"):
    # Раздел набора → схема записи. network и discovery — данные стенда, а не ответы API:
    # их строение проверяется ниже, в ссылках
    collections = {
        "domains": "Domain", "servers": "Server", "devices": "Device", "folders": "Folder",
        "archives": "Archive", "volumes": "Volume", "rules": "Rule", "ruleFires": "RuleFire", "ruleVersions": "RuleVersion",
        "schedules": "Schedule", "dayGroups": "DayGroup", "maintenanceWindows": "MaintenanceWindow",
        "licenses": "License", "journal": "JournalEvent", "streamAccounts": "StreamAccount", "archiveWatches": "ArchiveWatch", "archiveScans": "ArchiveScan",
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
    net_schema = dict(cand, properties=dict(cand["properties"], domainIds={"type": "array", "items": {"type": "string", "format": "uuid"}}))
    for i, rec in enumerate(fx.get("network", [])):
        validate(spec, net_schema, rec, f"network[{i}]", problems)
    # modeManual — режим, включённый вручную ({ modeId, until } или null): состояние стенда, ответ — GET /modes/current
    if fx.get("modeManual") is not None:
        validate(spec, {"$ref": "#/components/schemas/ModeCurrentWrite"}, fx["modeManual"], "modeManual", problems)
    # kinds, profiles, units — описания видов, профили, объекты склада: их проверяет check_units
    known = set(collections) | set(singles) | set(generic_legacy.OLD_TABLES) | {"access", "$comment", "version", "capturedAt", "timezone", "me", "network", "discovery", "modeManual", "stand", "scenarioDocs", "relays",
                                                "kinds", "profiles", "units"}
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
    layouts = own("layout", fx["reference"]["layouts"])
    monitors = own("monitor", fx["reference"]["monitors"])
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
    must(modes, fx["modes"]["otherwise"], "modes.otherwise", "режима")
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
                 "description", "title", "properties", "additionalProperties"}
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
        if not creates("vms.domain/1") and len(fx["domains"]) > 1:
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
         "/access/users", "/access/groups", "/access/history", "/access/cell-history", "/access/roles/{roleId}/objects", "/tree/children", "/domains/{domainId}/discovery",
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
    в нынешнем нет, и каждая снятая или изменённая (состав полей, перечень) схема названы в разделе README BREAKING_TITLE."""
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
    named = set(re.findall(r"`([^`]+)`", text))
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


def main():
    rep = Report()
    spec = load(f"{API}/openapi.json")
    # Набор хранит только units: старые разделы для проверок записей и ссылок выводятся из units тем же мостом,
    # что у сервера и profile_fixture.py (tools/generic_legacy.py)
    from generic_legacy import with_tables
    fx = with_tables(load(f"{API}/fixtures/demo.json"))
    profile = with_tables(load(f"{API}/fixtures/one-domain.json"))
    large = with_tables(load(f"{API}/fixtures/large.json"))
    check_contract(rep, spec)
    check_fixture(rep, spec, fx)
    check_fixture(rep, spec, profile, "Набор one-domain")
    check_fixture(rep, spec, large, "Набор large")
    check_units(rep, spec, fx)
    check_units(rep, spec, profile, "Набор one-domain")
    check_units(rep, spec, large, "Набор large")
    check_capabilities(rep, spec, {"demo": fx, "one-domain": profile, "large": large})
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "profile_fixture.py"), "--check", "--api", API], capture_output=True, text=True)
    rep.check("one-domain.json собран из нынешнего demo.json", [l for l in res.stdout.splitlines() if l] if res.returncode else [])
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_api.py"), "--check", "--api", API], capture_output=True, text=True)
    rep.check("openapi.js и fixture.js собраны из нынешних JSON", [l for l in res.stdout.splitlines() if l] if res.returncode else [])
    check_prototype(rep)
    check_server(rep, spec)
    check_core_field(rep, spec)
    check_backend_doc(rep, spec)
    check_breaking_doc(rep, spec)
    if "--lint" in sys.argv[1:]:
        res = subprocess.run(["npx", "-y", "@redocly/cli@1.34.0", "lint", os.path.join(ROOT, API, "openapi.json")],
                             capture_output=True, text=True, cwd=ROOT)
        tail = (res.stdout + res.stderr).strip().splitlines()[-3:]
        rep.check(f"redocly lint {API}/openapi.json", tail if res.returncode else [], tail[-1] if tail else "")
    print(f"RESULT {'fail' if rep.failed else 'pass'}")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
