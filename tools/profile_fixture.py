#!/usr/bin/env python3
"""Собрать набор под профиль api/fixtures/one-domain.json из эталонного api/fixtures/demo.json.

Профиль «один домен»: камеры и детекторы, хранилища из одного тома без шифрования, правила, пользователи.
Нет второго домена, прочих видов устройств, лицензий, поиска в сети, ролей и сетевых настроек серверов.
Так выглядит система, которая поддерживает только часть контракта: что она умеет — в
reference.capabilities, тесты и интерфейс прячут остальное (api/README.md, «Возможности системы»).

Набор не правят руками: правят demo.json или правила ниже и собирают заново.

Запуск из корня репозитория:
  python3 tools/profile_fixture.py          собрать
  python3 tools/profile_fixture.py --check  собранное не отстало от demo.json (код выхода 1, если отстало)
"""
import copy
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = "api/fixtures/demo.json"
OUT = "api/fixtures/one-domain.json"

DEVICE_TYPES = ["camera", "det"]
# Операции контракта, которых в профиле нет: второй домен, тома сверх первого, лицензии, поиск в сети
MISSING = ["createDomain", "deleteDomain", "createVolume", "deleteVolume", "listLicenses", "getDiscovery", "startDiscovery", "stopDiscovery"]
FEATURES = []


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
        if "recordDetectorIds" in d:
            d["recordDetectorIds"] = [x for x in d["recordDetectorIds"] if x in kept]
        if d.get("cameraId") and d["cameraId"] not in kept:
            d["cameraId"] = None
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

    def tgt(t):
        if not t or t["fromEvent"]:
            return t, True
        t = dict(t, include=[x for x in t["include"] if x["id"] in areas[x["kind"]]], exclude=[x for x in t["exclude"] if x in kept])
        return t, bool(t["include"] or t["gone"])

    def steps(lst):
        out = []
        for a in lst:
            a = dict(a)
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
    for d in fx["devices"]:
        if d.get("disabledByRuleId") and d["disabledByRuleId"] not in rids:
            d["disabledByRuleId"], d["disabledByRuleAt"] = None, None

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
    kinds = []
    for g in ref["deviceKinds"]:
        types = [t for t in g["types"] if t.split("-")[0] in DEVICE_TYPES]
        if types:
            kinds.append(dict(g, types=types))
    ref["deviceKinds"] = kinds
    caps = ref["capabilities"]
    caps["operations"] = [o for o in caps["operations"] if o not in MISSING]
    caps["deviceTypes"] = list(DEVICE_TYPES)
    caps["features"] = list(FEATURES)
    return fx


def render(fx):
    return json.dumps(fx, ensure_ascii=False, indent=1) + "\n"


def main():
    with open(os.path.join(ROOT, SRC), encoding="utf-8") as f:
        text = render(build(json.load(f)))
    path = os.path.join(ROOT, OUT)
    if "--check" in sys.argv[1:]:
        try:
            with open(path, encoding="utf-8") as f:
                if f.read() == text:
                    return 0
        except FileNotFoundError:
            pass
        print(f"{OUT} отстал от {SRC}\nСоберите: python3 tools/profile_fixture.py")
        return 1
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"{OUT} ← {SRC}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
