#!/usr/bin/env python3
"""Проверки целостности API прототипа 10.

1. Контракт api/openapi.json: OpenAPI 3.1, у каждой операции operationId (без повторов) и тег
   из списка тегов, каждая ссылка $ref ведёт в существующую схему.
2. Наборы api/fixtures/demo.json и one-domain.json: каждая запись соответствует схеме контракта, id
   уникальны, ссылки между записями ведут в существующие записи. Возможности (reference.capabilities) —
   из контракта, demo умеет весь контракт, данные набора не противоречат объявленному; one-domain.json
   собран из нынешнего demo.json (tools/profile_fixture.py --check).
3. api/openapi.js и api/fixture.js собраны из нынешних JSON (tools/build_api.py --check).
4. В HTML прототипа не осталось констант с данными сервера. Пока раздел не переведён, его константы
   перечислены в PENDING: такой список сокращается от этапа к этапу и не может отставать —
   константа из списка, которой уже нет в HTML, тоже ошибка.
5. Интерфейс не трогает внутренности сервера: ConsolemServer создаётся один раз и уходит в
   клиент, server.handle и данные сервера в HTML не встречаются.
6. Каждая операция контракта реализована в api/server.js и каждый маршрут сервера описан в контракте.
7. Числа в api/BACKEND.md (сколько операций и служебных) совпадают с контрактом.
С --lint дополнительно: npx @redocly/cli lint api/openapi.json.

Запуск из корня репозитория: python3 tools/check_api.py [--lint]
Код выхода 1, если что-то не прошло.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROTOTYPE = "index_api_server.html"
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
    r"\bconst RULE_(IDS|DEV)_A\s*=": "временная таблица этапа А: старые id в правилах, поля устройств",
}
# Ещё не переведены на API. Прототип API, этап А: «Автоматизация» — ещё константы макета, на этапе Б
# переводится целиком, и PENDING снова пустеет
PENDING = {
    r"\bconst rules\s*=\s*\[\s*\{",
    r"\bconst SCHEDS\s*=\s*\[\s*\{",
    r"\bconst DAY_GROUPS\s*=\s*\[\s*\{",
    r"\bconst OBJ_MODES\s*=\s*\[\s*\{",
    r"\bconst MAINT_WINDOWS\s*=\s*\[\s*\{",
    r"\bfunction ruleHistInit\b",
    r"\bfunction ruleFiresInit\b",
    r"\bconst RULE_(LAYOUTS|MONS)\s*=\s*\[\s*\"",
    r"\bconst RULE_(IDS|DEV)_A\s*=",
}


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
        "archives": "Archive", "volumes": "Volume", "rules": "Rule", "ruleFires": "RuleFire",
        "licenses": "License", "journal": "JournalEvent",
    }
    singles = {"access": "Access", "settings": "Settings", "reference": "Reference"}
    problems = []
    total = 0
    for key, name in collections.items():
        for i, rec in enumerate(fx.get(key, [])):
            validate(spec, {"$ref": f"#/components/schemas/{name}"}, rec, f"{key}[{i}]", problems)
            total += 1
    for key, name in singles.items():
        validate(spec, {"$ref": f"#/components/schemas/{name}"}, fx.get(key), key, problems)
    cand = spec["components"]["schemas"]["DiscoveryCandidate"]
    net_schema = dict(cand, properties=dict(cand["properties"], domainIds={"type": "array", "items": {"type": "string", "format": "uuid"}}))
    for i, rec in enumerate(fx.get("network", [])):
        validate(spec, net_schema, rec, f"network[{i}]", problems)
    known = set(collections) | set(singles) | {"$comment", "version", "capturedAt", "timezone", "me", "network", "discovery"}
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
    for f in fx["ruleFires"]:
        must(rules, f["ruleId"], f"ruleFire {f['id']}", "правила")
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


def check_capabilities(rep, spec, fixtures):
    """Возможности системы в наборах: из контракта; эталонный — весь контракт; данные набора не
    противоречат объявленному (нет устройств неподдержанных видов, шифрования без archiveEncryption…)."""
    product = [o["operationId"] for item in spec["paths"].values() for m, o in item.items()
               if m in ("get", "post", "put", "patch", "delete") and "test-support" not in o.get("tags", [])]
    schemas = spec["components"]["schemas"]
    types, features = schemas["DeviceType"]["enum"], schemas["Feature"]["enum"]
    problems = []
    for name, fx in fixtures.items():
        caps = fx["reference"]["capabilities"]
        ops = caps["operations"]
        problems += [f"{name}: операции {o} нет в контракте или она служебная" for o in ops if o not in product]
        problems += [f"{name}: нет обязательной {o}" for o in ("getMe", "getReference", "stream") if o not in ops]
        if len(set(ops)) != len(ops):
            problems.append(f"{name}: операции повторяются")
        problems += [f"{name}: устройство {d['name']} вида {d['type']} — вид не объявлен" for d in fx["devices"] if d["type"] not in caps["deviceTypes"]]
        if "archiveEncryption" not in caps["features"]:
            problems += [f"{name}: хранилище {a['name']} зашифровано без archiveEncryption" for a in fx["archives"] if a["encrypted"]]
        if "createVolume" not in ops:
            per = {}
            for v in fx["volumes"]:
                per[v["archiveId"]] = per.get(v["archiveId"], 0) + 1
            problems += [f"{name}: у хранилища {a} томов {n} без createVolume" for a, n in per.items() if n > 1]
        if "listLicenses" not in ops and fx["licenses"]:
            problems.append(f"{name}: лицензии без listLicenses")
        if "getDiscovery" not in ops and (fx["discovery"] or fx["network"]):
            problems.append(f"{name}: итоги поиска без getDiscovery")
        if "createDomain" not in ops and len(fx["domains"]) > 1:
            problems.append(f"{name}: доменов {len(fx['domains'])} без createDomain")
    demo = fixtures["demo"]["reference"]["capabilities"]
    if demo != {"operations": product, "deviceTypes": types, "features": features}:
        problems.append("demo: возможности — не весь контракт (соберите: tools/fixture_normalize.capabilities())")
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
    if read("api/server.js") is None:
        rep.info("api/server.js ещё нет — сверка маршрутов сервера с контрактом пропущена (этап 4)")
        return
    # Маршруты — у самого сервера: часть их собирается кодом, в тексте файла их не найти
    script = (
        "global.window=global;require('./api/contract.js');require('./api/server.js');"
        "const fx=require('./api/fixtures/demo.json');"
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
        "global.window=global;require('./api/contract.js');require('./api/server.js');"
        "const fx=require('./api/fixtures/demo.json');"
        "const s=window.ConsolemServer.create({fixture:fx,autoTick:false,testSupport:true});"
        "const d=fx.devices[0];const got=[];s.subscribe(m=>got.push(m));"
        "let v=d.version;const h=n=>{v=s.handle('PATCH','/devices/'+d.id,{name:n},{'If-Match':'\"'+v+'\"'}).body.version};"
        "h('a');h('b');h('c');"
        "setTimeout(()=>{const first=got[0].id,missed=[],reset=[];"
        "s.subscribe(m=>missed.push(m),first);s.subscribe(m=>reset.push(m),'999999');"
        "setTimeout(()=>console.log(JSON.stringify({sent:got.map(m=>m.id),missed:missed.map(m=>m.id),reset:reset.map(m=>m.type)})),10)},10)"
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
    bare = lambda p: re.sub(r"\{\w+\}", "{}", p)
    routes = {(r.split(" ", 1)[0], bare(r.split(" ", 1)[1])) for r in json.loads(res.stdout)}
    ops = {(m.upper(), bare(p)) for p, item in spec["paths"].items() for m in METHODS if m in item}
    problems = [f"{m} {p}: в контракте есть, в server.js нет" for m, p in sorted(ops - routes)]
    problems += [f"{m} {p}: в server.js есть, в контракте нет" for m, p in sorted(routes - ops)]
    rep.check("Каждая операция контракта реализована в server.js, каждый маршрут описан в контракте", problems, f"{len(ops)} операций")


# ===== 7. Памятка =====

def check_backend_doc(rep, spec):
    doc = read("api/BACKEND.md")
    if doc is None:
        rep.info("api/BACKEND.md ещё нет — сверка чисел пропущена (этап 7)")
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


def main():
    rep = Report()
    spec = load("api/openapi.json")
    fx = load("api/fixtures/demo.json")
    profile = load("api/fixtures/one-domain.json")
    check_contract(rep, spec)
    check_fixture(rep, spec, fx)
    check_fixture(rep, spec, profile, "Набор one-domain")
    check_capabilities(rep, spec, {"demo": fx, "one-domain": profile})
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "profile_fixture.py"), "--check"], capture_output=True, text=True)
    rep.check("one-domain.json собран из нынешнего demo.json", [l for l in res.stdout.splitlines() if l] if res.returncode else [])
    res = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build_api.py"), "--check"], capture_output=True, text=True)
    rep.check("openapi.js и fixture.js собраны из нынешних JSON", [l for l in res.stdout.splitlines() if l] if res.returncode else [])
    check_prototype(rep)
    check_server(rep, spec)
    check_backend_doc(rep, spec)
    if "--lint" in sys.argv[1:]:
        res = subprocess.run(["npx", "-y", "@redocly/cli@1.34.0", "lint", os.path.join(ROOT, "api", "openapi.json")],
                             capture_output=True, text=True, cwd=ROOT)
        tail = (res.stdout + res.stderr).strip().splitlines()[-3:]
        rep.check("redocly lint api/openapi.json", tail if res.returncode else [], tail[-1] if tail else "")
    print(f"RESULT {'fail' if rep.failed else 'pass'}")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
