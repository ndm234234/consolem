#!/usr/bin/env python3
"""Собрать набор под профиль api/fixtures/one-domain.json из эталонного api/fixtures/demo.json.

Профиль «один домен»: камеры и детекторы, хранилища из одного тома без шифрования, правила, пользователи.
Нет второго домена, прочих видов устройств, лицензий, поиска в сети, ролей и сетевых настроек серверов.
Так выглядит система, которая поддерживает только часть контракта: что она умеет — в
reference.capabilities, тесты и интерфейс прячут остальное (api/README.md, «Возможности системы»).

Набор не правят руками: правят demo.json или правила ниже и собирают заново.

Набор api/fixtures/large.json — стенд большого домена: профиль «один домен» без записей оборудования, а в stand.large
только числа: 250 000 камер, 500 серверов. Записи считает заглушка при загрузке (api/server.js, expandLarge), в файле
набора их нет. Загружается ?fixture=large, POST /test/reset {fixture: "large"}, node tools/serve_api.mjs --fixture large.

Набор api/fixtures/xl.json — тот же large с другими числами stand.large: 1 000 000 камер, 2 000 серверов, 1 200 папок
в четырёх доменах (Москва, Санкт-Петербург, Казань, Новосибирск) по 250 000 камер, 500 серверов и 300 папок.
В файле — только наложение: "$base": "large" и stand. Целый набор собирают из large при загрузке tools/build_api.py
(в api/fixture.js — Object.assign поверх large, а не вторая копия) и tools/serve_api.mjs. Загружается ?fixture=xl,
POST /test/reset {fixture: "xl"}, node tools/serve_api.mjs --fixture xl.

Набор хранит units вместо domains, servers, devices, folders, archives, volumes: старые разделы выводятся из units
(tools/generic_legacy.py), отбираются, и объекты собираются из них заново. Объектов незнакомых видов в профиле нет: в нём
только камеры и детекторы.

Запуск из корня репозитория:
  python3 tools/profile_fixture.py          собрать
  python3 tools/profile_fixture.py --check  собранное не отстало от demo.json (код выхода 1, если отстало)
"""
import copy
import json
import os
import re
import sys

import cli_paths
import generic_legacy

API = cli_paths.opt("api", "api")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = f"{API}/fixtures/demo.json"
OUT = f"{API}/fixtures/one-domain.json"
OUT_LARGE = f"{API}/fixtures/large.json"
OUT_XL = f"{API}/fixtures/xl.json"
# Камер всего, серверов, папок; под серверами из них 50 000, из них на первом — ветка больше страницы.
# Остальные 200 000 — камеры-кластеры: без сервера и родителя, лежат прямо под доменом
LARGE = {"cameras": 250000, "servers": 500, "folders": 300, "serverCameras": 50000, "firstBranch": 1000, "clusters": 40, "relayed": 5}
# xl — large в четыре раза, четырьмя доменами: числа на весь набор, expandLarge делит их поровну, и каждый домен — как
# large: 250 000 камер, 500 серверов в 40 кластерах, 300 папок, 50 000 камер под серверами (на сервере ~100, камер-кластеров
# 80 %). Ветка первого сервера — 1 000 в каждом домене (firstBranch — на домен: она нужна длиннее страницы, а не
# пропорциональной). Ретранслятор — у первого домена, за ним его доля: 5 кластеров из 20
XL = {"cameras": 1000000, "servers": 2000, "folders": 1200, "serverCameras": 200000, "firstBranch": 1000, "clusters": 160, "relayed": 20,
      "domains": 4, "domainNames": ["Москва", "Санкт-Петербург", "Казань", "Новосибирск"]}

DEVICE_TYPES = ["camera", "det"]
# Операции контракта, которых в профиле нет: второй домен, тома сверх первого, лицензии, поиск в сети.
# Завести и удалить объект вида — UnitKind.capabilities: второго домена и второго тома в профиле нет, у видов домена и тома
# сняты create и delete. Первый том хранилища заводит само хранилище — вместе с ним строкой tom, отдельно том не создаётся
KIND_MISSING = {"domain": ["create", "delete"], "volume": ["create", "delete"]}
KIND_ONLY_WITH_PARENT = ["volume"]
# Виды плагинов и тестовые виды: в профиле «один домен» их нет — система объявляет только свои (тесты с needs "kind:…" пропускаются)
PLUGIN_KINDS = ["security_controller/CONTROLLER", "security_controller/SENSOR", "test.unknown", "test.perunit", "w2c.example/rows", "domain.shared"]
# Виды, чьи события и действия правил система профиля объявляет, хотя объектов этих видов у неё нет (вход датчика io.input,
# текст источника, событие и команда единицы СКУД, выход реле) — редактор правил их предлагает. Каталог правил — из описаний
# видов, поэтому описания остаются, но завести такой объект нельзя: без create и createParents, без x-ui-category (в мастере их нет)
RULE_ONLY_KINDS = ["sensor", "relay", "eventsrc", "acfa", "acfa_sensor", "acfa_lock", "acfa_fence"]
MISSING = ["startTalk", "listArchiveWatches", "createArchiveWatch", "patchArchiveWatch", "deleteArchiveWatch", "runDeviceOperation", "assistTurn", "createDomain", "deleteDomain", "createVolume", "deleteVolume", "listLicenses", "getDiscovery", "startDiscovery", "stopDiscovery", "syncCatalog"]
# Выгрузка первой генерации VMS (ADR-0117 § 8, доп. (1) п. 3): треки, маска, плеер, облако, титры событий — позже
FEATURES = ["exportVideo", "exportFrame", "exportLiveFrame", "exportArea", "exportMultiCamera", "exportMultiPeriod", "exportSingleFile", "exportTranscode", "exportTitles", "exportAudio", "exportPassword"]
# «Автоматизация» по части каталога, как у w2c: этих действий система не исполняет, запись — только на минуты
# Команды видов (UnitKind.actions, ruleOnly), которых в профиле нет; действия системы (reference.ruleActions) — ACTIONS_OFF: к ним
# добавлены ntf.push и client.*, которых у профиля нет, но команды видов с теми же кодами (program сервера) остаются
KIND_ACTIONS_OFF = ["alarmclose", "layout", "wall", "email", "tg", "http"]
ACTIONS_OFF = KIND_ACTIONS_OFF + ["push", "sound", "voice", "view", "program"]
# Правило, сохранённое раньше и теперь вне каталога: остаётся выключенным, форма его показывает
OUT_OF_CATALOG = "Вход на видеостене по движению"


def build(demo):
    fx = copy.deepcopy(demo)
    fx["$comment"] = (
        "Набор под профиль «один домен»: камеры и детекторы, хранилища из одного тома без шифрования, правила, "
        "пользователи. Что система умеет — reference.capabilities. Собран tools/profile_fixture.py из demo.json, "
        "руками не правится. Загружается POST /test/reset {fixture: \"one-domain\"}."
    )
    dom = fx["domains"][0]
    fx["domains"] = [dom]
    did = dom["id"]

    servers = [s for s in fx["servers"] if s["domainId"] == did]
    for s in servers:
        for k in ("netmask", "gateway", "dns"):
            s.pop(k, None)
    fx["servers"] = servers
    sids = {s["id"] for s in servers}

    archives = [a for a in fx["archives"] if a["serverId"] in sids or a["domainId"] == did]
    for a in archives:
        a["encrypted"] = False
    fx["archives"] = archives
    aids = {a["id"] for a in archives}
    first = {}
    for v in fx["volumes"]:
        if v["archiveId"] in aids and v["archiveId"] not in first:
            first[v["archiveId"]] = v
    fx["volumes"] = [v for v in fx["volumes"] if first.get(v["archiveId"]) is v]

    # Устройства идут родитель первым: дочернее остаётся, только если остался родитель
    devices, kept = [], set()
    for d in fx["devices"]:
        if d["domainId"] != did or d["type"] not in DEVICE_TYPES or (d["parentId"] and d["parentId"] not in kept):
            continue
        kept.add(d["id"])
        devices.append(d)
    for d in devices:
        d.pop("licenseExceeded", None)
        if d.get("archiveId") and d["archiveId"] not in aids:
            d["archiveId"], d["recordMode"] = None, "none"
        if "extraArchives" in d:
            d["extraArchives"] = [x for x in d["extraArchives"] if x["archiveId"] in aids]
        if d.get("audioDeviceId") and d["audioDeviceId"] not in kept:
            del d["audioDeviceId"]
        if "recordDetectorIds" in d:
            d["recordDetectorIds"] = [x for x in d["recordDetectorIds"] if x in kept]
        if d.get("cameraId") and d["cameraId"] not in kept:
            d["cameraId"] = None
    # Встроенного хранилища в профиле нет: забирать записи не откуда
    def live(x, flag):
        if x.get("recordMode") == "replica" and not x.get("replicaFrom"):
            x["recordMode"] = "always"
            for k in ("replicaFrom", "replicaLagSec", "state", "reason") if flag else ("replicaFrom", "replicaLagSec", "recordState", "recordReason"):
                x.pop(k, None)
    for d in devices:
        live(d, False)
        for x in d.get("extraArchives", []):
            live(x, True)
    fx["devices"] = devices

    folders = [f for f in fx["folders"] if f["domainId"] == did]
    for f in folders:
        f["deviceIds"] = [x for x in f["deviceIds"] if x in kept]
    fx["folders"] = folders
    fids = {f["id"] for f in folders}

    # Правила: из целей уходят устройства и области, которых в профиле нет; события, условия и шаги
    # с опустевшей целью — тоже; правило без событий (по событию) или без действий — целиком
    sids = {s["id"] for s in fx["servers"]}
    areas = {"device": kept, "folder": fids, "server": sids, "domain": {did}}

    # Элемент цели: {uid} — объект, {area, uid} — область
    def item_kept(x):
        return x["uid"] in areas[x.get("area", "device")]

    def tgt(t):
        if not t or t["fromEvent"]:
            return t, True
        t = dict(t, include=[x for x in t["include"] if item_kept(x)], exclude=[x for x in t["exclude"] if x in kept])
        return t, bool(t["include"] or t["gone"])

    def steps(lst):
        out = []
        for a in lst:
            a = dict(a)
            if a.get("action") in (KIND_ACTIONS_OFF if a.get("type") == "unitAction" else ACTIONS_OFF):
                continue
            if a.get("action") == "record":
                # Поля действия на объекте (unitAction) — в params
                p = a
                if a.get("type") == "unitAction":
                    p = a["params"] = dict(a["params"])
                p.update(duration="min", minutes=p.get("minutes") or 10)
                p.pop("afterSec", None)
            if a.get("control") == "waitEvent":
                a["event"]["target"], ok = tgt(a["event"]["target"])
                if not ok:
                    continue
            for k in ("yes", "no"):
                if k in a:
                    a[k] = steps(a[k])
            if "target" in a:
                a["target"], ok = tgt(a["target"])
                if not ok and a["target"] is not None:
                    continue
            out.append(a)
        return out

    def has_action(lst):
        return any("action" in a or has_action(a.get("yes", []) + a.get("no", [])) for a in lst)

    def prune(r):
        r["triggers"] = [dict(t, target=tgt(t["target"])[0]) for t in r["triggers"] if tgt(t["target"])[1]]
        r["conditions"] = [dict(c, target=tgt(c["target"])[0]) if "target" in c else c for c in r["conditions"] if "target" not in c or tgt(c["target"])[1]]
        if r["name"] == OUT_OF_CATALOG:
            r["enabled"] = False
        else:
            r["steps"] = steps(r["steps"])
        if len(r["triggers"]) < 2:
            r["windowSec"] = 0
        if r["serverId"] not in sids:
            r["serverId"] = None

    rules = []
    for r in fx["rules"]:
        prune(r)
        if (r["triggers"] or r["start"] != "event") and has_action(r["steps"]):
            rules.append(r)
    fx["rules"] = rules
    rids = {r["id"] for r in rules}
    for r in rules:
        r["steps"] = [a for a in r["steps"] if a.get("action") != "runrule" or a["ruleId"] in rids]
    fx["ruleVersions"] = [v for v in fx["ruleVersions"] if v["ruleId"] in rids]
    for v in fx["ruleVersions"]:
        prune(v["rule"])
        v["rule"]["steps"] = [a for a in v["rule"]["steps"] if a.get("action") != "runrule" or a["ruleId"] in rids]
    devs = lambda f: f["sourceDeviceIds"] + [e["deviceId"] for e in f["events"]] + [s["deviceId"] for s in f["steps"]]
    fx["ruleFires"] = [f for f in fx["ruleFires"] if f["ruleId"] in rids and all(x is None or x in kept for x in devs(f))]
    for w in fx["maintenanceWindows"]:
        if w["ruleIds"] is not None:
            w["ruleIds"] = [x for x in w["ruleIds"] if x in rids]
    for m in fx["modes"]["items"]:
        m["off"]["ruleIds"] = [x for x in m["off"]["ruleIds"] if x in rids]
    for d in fx["devices"]:
        if d.get("disabledByRuleId") and d["disabledByRuleId"] not in rids:
            d["disabledByRuleId"], d["disabledByRuleAt"] = None, None

    # Обход смотрит архив устройства: встроенных хранилищ в профиле нет
    fx["archiveWatches"] = []
    fx["archiveScans"] = [x for x in fx["archiveScans"] if x["deviceId"] in kept and x["archiveId"] in aids]
    fx["licenses"] = []
    fx["network"] = []
    fx["discovery"] = []

    def obj_kept(k):
        if k.startswith("vw:"):
            return k[3:] in sids
        if k.startswith("macro:"):
            return k[6:] in rids
        return k.startswith("plug:") or k in kept or k in aids

    for role in fx["access"]["roles"]:
        role["folderAccess"] = {k: v for k, v in role["folderAccess"].items() if k in fids or k == did}
        role["objectAccess"] = {k: v for k, v in role["objectAccess"].items() if obj_kept(k)}

    ref = fx["reference"]
    ref["ruleActions"] = [a for a in ref["ruleActions"] if a["action"] not in ACTIONS_OFF]
    for a in ref["ruleActions"]:
        if a["action"] == "record":
            a["fields"] = [dict(f, options=["min"]) if f["id"] == "duration" else f for f in a["fields"] if f["id"] != "afterSec"]
    # Права: система объявляет меньше, как w2c: без вида tel, без MON_PROT и DEV, без части функций,
    # запретов, плагинов и каталогов. Значений, которых система не знает, в ролях не остаётся
    acc = ref["access"]
    del acc["levels"]["tel"]
    acc["levels"]["cam"] = [x for x in acc["levels"]["cam"] if x != "MON_PROT"]
    acc["levels"]["ur"] = [x for x in acc["levels"]["ur"] if x != "DEV"]
    acc["defaults"] = [x for x in acc["defaults"] if x["levels"] != "tel"]
    acc["folderFields"] = [x for x in acc["folderFields"] if x != "tel"]
    if "fieldDefaults" in acc:
        del acc["fieldDefaults"]["tel"]
    del acc["visibleFrom"]["tel"]
    acc["features"] = [x for x in acc["features"] if x not in ("IS_GUARD_ROLE", "ALLOW_SHOW_FACES_IN_LIVE")]
    acc["restrictions"] = []
    acc["plugins"] = []

    def levels_of(row):
        row.pop("tel", None)
        if row.get("cam") == "MON_PROT":
            row["cam"] = "MON"
        return row

    fx["access"]["catalogs"] = []
    fx["access"].pop("streamGrants", None)
    for g in fx["access"]["groups"]:
        g["source"] = None
    for u in fx["access"]["users"]:
        u["catalogId"], u["webSessions"], u["mobileSessions"] = None, 0, 0
        if not u["hasPassword"]:
            u["hasPassword"], u["passwordByAdmin"] = True, True
        u.pop("syncedGroupId", None)
    for role in fx["access"]["roles"]:
        role["loginSchedule"] = 0
        role["supervision"] = {"roleId": None, "login": False, "export": False}
        g = role["global"]
        g.pop("dTel", None)
        g["depth"], g["restr"] = 0, {}
        g["feat"] = [x for x in g["feat"] if x in acc["features"]]
        if g.get("dCam") == "MON_PROT":
            g["dCam"] = "MON"
        # Умолчания роли — Role.kindAccess по классам
        if "kindAccess" in role:
            levels_of(role["kindAccess"])
        if not g["unr"]:
            g["ur"] = "ALL" if "USERS_RIGHTS_SETUP" in g["feat"] else "NO"
        role["folderAccess"] = {k: levels_of(v) for k, v in role["folderAccess"].items()}
        role["objectAccess"] = {k: levels_of(v) for k, v in role["objectAccess"].items() if not k.startswith("plug:")}
        role["folderAccess"] = {k: v for k, v in role["folderAccess"].items() if v}
        role["objectAccess"] = {k: v for k, v in role["objectAccess"].items() if v}

    # Какие виды есть у системы — описания видов (GET /kinds): виды устройств и хранилищ профиля, их права и действия
    kinds_access(fx["kinds"], acc["levels"])
    fx["kinds"] = profile_kinds(fx["kinds"])

    caps = ref["capabilities"]
    caps["operations"] = [o for o in caps["operations"] if o not in MISSING]
    # Только возможности, которые знает контракт (Feature)
    caps["features"] = [f for f in FEATURES if f in contract_features()]
    return fx


def contract_features():
    """Перечень Feature из {API}/openapi.json."""
    with open(os.path.join(ROOT, API, "openapi.json"), encoding="utf-8") as f:
        return set(json.load(f)["components"]["schemas"]["Feature"]["enum"])


def profile_kinds(kinds):
    """Виды, которые объявляет система профиля (вместо capabilities.deviceTypes): из видов устройств — только DEVICE_TYPES,
    хранилища — без «Облачного», как у w2c (ADR-0112 доп. (5) п. 2); остальные виды — как в demo. Ссылки на снятые виды
    (parents, createParents, children, x-ref kinds) уходят. Чего система не умеет с видом (второй домен, второй том), то снято
    с UnitKind.capabilities (KIND_MISSING); том заводится только вместе с новым хранилищем (KIND_ONLY_WITH_PARENT)."""
    drop = {k for k in generic_legacy.DEVICE_TYPES if k not in DEVICE_TYPES + RULE_ONLY_KINDS} | {"archive.cloud"} | {k["kind"] for k in kinds if k["kind"] in PLUGIN_KINDS}

    def gone_ref(s):
        ref = s.get("x-ref") if isinstance(s, dict) else None
        return isinstance(ref, dict) and "kinds" in ref and not ref.get("implements") and not [k for k in ref["kinds"] if k not in drop]

    def clean(node):
        if isinstance(node, dict):
            ref = node.get("x-ref")
            if isinstance(ref, dict) and "kinds" in ref and not gone_ref(node):
                ref["kinds"] = [k for k in ref["kinds"] if k not in drop]
            # Свойство-ссылка только на снятые виды (у камеры — микрофон звука): свойство профиля остаётся, ссылаться не на что —
            # без x-ref и только для чтения
            props = node.get("properties")
            if isinstance(props, dict):
                for n in [n for n, s in props.items() if gone_ref(s)]:
                    del props[n]["x-ref"]
                    props[n]["readOnly"] = True
            for v in node.values():
                clean(v)
        elif isinstance(node, list):
            for v in node:
                clean(v)
    out = []
    for k in kinds:
        if k["kind"] in drop:
            continue
        for key in ("parents", "createParents", "children"):
            if key in k:
                k[key] = [p for p in k[key] if p not in drop]
        if k["kind"] in KIND_MISSING and "capabilities" in k:
            k["capabilities"] = [c for c in k["capabilities"] if c not in KIND_MISSING[k["kind"]]]
            # Не заводится — и заводить не под чем
            if "create" not in k["capabilities"]:
                k["createParents"] = []
        if k["kind"] in KIND_ONLY_WITH_PARENT:
            k["createParents"] = []
        if k["kind"] in RULE_ONLY_KINDS:
            k["capabilities"] = [c for c in k.get("capabilities", []) if c != "create"]
            k["createParents"] = []
            k.pop("x-ui-category", None)
        clean(k.get("schema"))
        out.append(k)
    return out


def kinds_access(kinds, levels):
    """Описания видов — как справочник профиля: уровни классов — reference.access.levels, классов, которых
    в профиле нет (tel), нет и у видов, у прав по ним — тоже; действий вне каталога (ACTIONS_OFF) нет, запись — только на минуты."""
    def cls_ok(right):
        return not right or "class" not in right or right["class"] in levels
    for k in kinds:
        acc = k.get("access")
        if acc:
            acc["also"] = [x for x in acc.get("also", []) if x["class"] in levels]
            if not acc["also"]:
                del acc["also"]
            for x in [acc] + acc.get("also", []):
                if x["class"] in levels:
                    x["levels"] = list(levels[x["class"]])
        if "apiRights" in k:
            k["apiRights"] = {p: r for p, r in k["apiRights"].items() if cls_ok(r)}
            if not k["apiRights"]:
                del k["apiRights"]
        if "actions" in k:
            k["actions"] = [a for a in k["actions"] if not (a.get("ruleOnly") and a["id"] in KIND_ACTIONS_OFF)]
            for a in k["actions"]:
                for key in ("right", "ruleRight"):
                    if not cls_ok(a.get(key)):
                        del a[key]
                if a["id"] == "record" and a.get("ruleAction"):
                    props = a["params"]["properties"]
                    props.pop("afterSec", None)
                    props["duration"]["enum"] = ["min"]
        for e in k.get("events", []):
            if not cls_ok(e.get("right")):
                del e["right"]


def build_large(demo):
    fx = build(demo)
    fx["$comment"] = (
        "Стенд большого домена: 250 000 камер, 500 серверов. Записи считает заглушка из stand.large при загрузке, "
        "в файле только числа. Собран tools/profile_fixture.py из demo.json, руками не правится."
    )
    fx["stand"] = {"large": LARGE}
    # В отличие от «одного домена» у большого стенда есть ассистент: check_perf меряет поиск вместе с ним (шаг gq-enter-asst).
    # Операция и функция встают на свои места по порядку demo
    caps, dcaps = fx["reference"]["capabilities"], demo["reference"]["capabilities"]
    caps["operations"] = [o for o in dcaps["operations"] if o in caps["operations"] or o == "assistTurn"]
    caps["features"] = [f for f in dcaps["features"] if f in caps["features"] or f == "assist"]
    for k in ("servers", "archives", "volumes", "devices", "folders", "rules", "ruleVersions", "ruleFires", "archiveScans", "archiveWatches", "journal"):
        fx[k] = []
    fx.pop("relays", None)
    for w in fx["maintenanceWindows"]:
        if w["ruleIds"] is not None:
            w["ruleIds"] = []
    for m in fx["modes"]["items"]:
        m["off"]["ruleIds"] = []
    for role in fx["access"]["roles"]:
        role["objectAccess"] = {}
        role["folderAccess"] = {k: v for k, v in role["folderAccess"].items() if k == fx["domains"][0]["id"]}
    return fx


UNIT_UID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4000-8000-[0-9a-f]{12}")


def via_units(build_fx):
    """Сборка набора: старые разделы — из units, после отбора — снова объекты склада."""
    def run(demo):
        fx = build_fx(generic_legacy.with_tables(demo))
        fx["units"] = generic_legacy.units_from_tables(fx)
        for t in generic_legacy.OLD_TABLES:
            del fx[t]
        # Журнал demo набор не отбирает; его ссылки — на объекты склада (check_api.py), поэтому
        # записи об объектах, которых в наборе нет, уходят. uid объекта склада — с первой цифрой 1–6, как в check_api.py
        have = {u["uid"] for u in fx["units"]}
        fx["journal"] = [j for j in fx.get("journal", []) if all(m[0] not in "123456" or m in have for m in UNIT_UID.findall(json.dumps(j)))]
        return fx
    return run


def build_xl():
    """Наложение поверх large: только числа стенда. Остальное — из large (tools/build_api.py, tools/serve_api.mjs)."""
    return {
        "$comment": (
            "Стенд xl: набор large с другими числами stand.large — 1 000 000 камер, 2 000 серверов, 1 200 папок "
            "в четырёх доменах поровну. "
            "Наложение: целый набор — large и поверх него эти поля. Собран tools/profile_fixture.py, руками не правится."
        ),
        "$base": "large",
        "stand": {"large": XL},
    }


def render(fx):
    return json.dumps(fx, ensure_ascii=False, indent=1) + "\n"


def main():
    with open(os.path.join(ROOT, SRC), encoding="utf-8") as f:
        demo = json.load(f)
    code = 0
    for out, fx in ((OUT, via_units(build)(copy.deepcopy(demo))), (OUT_LARGE, via_units(build_large)(copy.deepcopy(demo))), (OUT_XL, build_xl())):
        text = render(fx)
        path = os.path.join(ROOT, out)
        if "--check" in sys.argv[1:]:
            try:
                with open(path, encoding="utf-8") as f:
                    if f.read() == text:
                        continue
            except FileNotFoundError:
                pass
            print(f"{out} отстал от {SRC}\nСоберите: python3 tools/profile_fixture.py")
            code = 1
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{out} ← {SRC}")
    return code


if __name__ == "__main__":
    sys.exit(main())
