"""Снимок памяти основного макета (index.html) → эталонный набор в виде контракта api/openapi.json.

Вызывается из tools/extract_fixture.py. Что меняется по сравнению с данными макета:
- идентификаторы — UUID: первая цифра — вид записи (KIND), дальше — номер по порядку;
- русские строки-значения — коды (роль сервера, вид детектора, режим оповещателя);
- размеры «4 ТБ» — байты, занятость «68%» — число, координаты — числа;
- связи — id: домен сервера, родитель устройства, владелец хранилища, том → хранилище;
- поля с сокращёнными именами получают понятные (FIELD), служебные и вычисляемые убраны;
- местное время журнала и прав — UTC по часовому поясу системы (TZ_OFFSET).
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone

# Вид записи — первая цифра UUID: по id сразу видно, чей он. Сервер выдаёт
# новые id по той же схеме, продолжая номер
KIND = {
    "operation": "0", "domain": "1", "server": "2", "device": "3", "folder": "4", "archive": "5",
    "volume": "6", "rule": "7", "role": "8", "user": "9", "group": "a", "catalog": "b",
    "journal": "c", "fire": "d", "history": "e", "candidate": "f",
    # Виды «Автоматизации» основного макета: первая цифра «f» и свой номер во второй группе UUID
    "schedule": ("f", "0001"), "dayGroup": ("f", "0002"), "mode": ("f", "0003"), "window": ("f", "0004"),
    "ruleVersion": ("f", "0005"), "layout": ("f", "0006"), "monitor": ("f", "0007"),
}
# Часовой пояс системы (настройка ntp.tz): в нём записано местное время макета
TZ = "Europe/Moscow"
TZ_OFFSET = timedelta(hours=3)

SERVICES = {"export", "email", "sms"}
SERVER_ROLE = {"Основной": "primary", "Узел": "node"}
DETECTOR_KIND = {
    "Движение": "motion", "Пересечение линии": "linecross", "Оставленный предмет": "abandoned",
    "Исчезновение предмета": "disappeared", "Скопление людей": "crowd",
}
EMAIL_MODE = {"AxxonNet": "axxonnet", "Облачный AxxonNet": "axxonnet", "SMTP сервер": "smtp"}
JOURNAL_CATEGORY = {"Аудит": "audit", "Тревога": "alarm", "Инфо": "info"}
PARAM_OPTION = {"Разомкнуто": "open", "Замкнуто": "closed"}
TWO_FA = {"Нет": "off", "Обязательно админам": "admins"}

# Поля устройства: имя в макете → имя в контракте. Остальные переносятся как есть
FIELD = {
    "srvId": "serverId", "arch": "archiveId", "rec": "recordMode", "recDets": "recordDetectorIds",
    "err": "fault", "vch": "videoChannel", "ch": "channel",
    "server": "onServer", "camera": "cameraId", "user": "login", "pre": "preRecordSec",
}
DROP = {"devices", "type", "id", "pass", "kind", "sens", "size", "archx", "lat", "lon", "azimuth", "ruleOff", "armed"}


class Ids:
    def __init__(self):
        self.seq = {k: 0 for k in KIND}
        self.map = {}

    def new(self, kind, old):
        self.seq[kind] += 1
        first, second = KIND[kind] if isinstance(KIND[kind], tuple) else (KIND[kind], "0000")
        uid = f"{first}{self.seq[kind]:07d}-{second}-4000-8000-000000000000"
        self.map[(kind, old)] = uid
        return uid

    def __call__(self, kind, old):
        if old is None or old == "":
            return None
        return self.map[(kind, old)]


def size_bytes(text):
    m = re.search(r"([\d.,]+)\s*(ТБ|ГБ|TB|GB)", text or "")
    if not m:
        raise ValueError(f"размер не разобран: {text!r}")
    n = float(m.group(1).replace(",", "."))
    return int(round(n * 1024 ** (4 if m.group(2) in ("ТБ", "TB") else 3)))


def num(text):
    return float(text) if text not in (None, "") else None


def local_to_utc(text):
    """«2026-10-29 13:55» по времени системы → ISO UTC."""
    t = datetime.strptime(text, "%Y-%m-%d %H:%M") - TZ_OFFSET
    return t.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clock_seq_to_utc(times, captured):
    """Ряд времён суток от нового к старому («14:02:11», «13:45:18», …): первое — последний такой момент
    не позже снимка, каждое следующее — раньше предыдущего, через полночь — на день назад."""
    out, prev = [], None
    for hhmm in times:
        t = datetime.strptime(clock_to_utc(hhmm, captured), "%Y-%m-%dT%H:%M:%SZ")
        if prev is not None:
            while t > prev:
                t -= timedelta(days=1)
            while t + timedelta(days=1) <= prev:
                t += timedelta(days=1)
        out.append(t.strftime("%Y-%m-%dT%H:%M:%SZ"))
        prev = t
    return out


def clock_to_utc(hhmm, captured):
    """Время суток без даты («21:56», «14:02:11») — последний такой момент не позже снимка."""
    parts = [int(x) for x in hhmm.split(":")] + [0]
    local_now = captured + TZ_OFFSET
    t = local_now.replace(hour=parts[0], minute=parts[1], second=parts[2], microsecond=0)
    if t > local_now:
        t -= timedelta(days=1)
    return (t - TZ_OFFSET).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize(raw, captured_at):
    captured = datetime.strptime(captured_at, "%Y-%m-%dT%H:%M:%SZ")
    ids = Ids()
    out = {
        "$comment": (
            "Эталонный набор конфигуратора: его загружает встроенный сервер прототипа и бэкенд на тестовом "
            "стенде (POST /test/reset). Записи — в том же виде, что в ответах API (api/openapi.json). "
            "capturedAt — момент снимка: при загрузке все даты и моменты времени сдвигаются на «сейчас − "
            "capturedAt», и набор выглядит свежим в любой день. Собран из прототипа 09 tools/extract_fixture.py, "
            "дальше правится руками. Формат — api/README.md, «Эталонный набор»."
        ),
        "version": 1,
        "capturedAt": captured_at,
        "timezone": TZ,
    }

    # Идентификаторы раздаются заранее: записи ссылаются друг на друга вперёд
    for d in raw["domains"]:
        ids.new("domain", d["id"])
    for s in raw["servers"]:
        ids.new("server", s["id"])
    services, pool = [], []

    def walk(n, parent, acc):
        ids.new("device", n["id"])
        acc.append((n, parent))
        for c in n.get("devices") or []:
            walk(c, n, acc)

    for s in raw["servers"]:
        for d in s.get("devices") or []:
            walk(d, None, services)
    for d in raw["devicePool"]:
        walk(d, None, pool)

    def walk_folders(f, acc):
        ids.new("folder", f["id"])
        acc.append(f)
        for c in f["folders"]:
            walk_folders(c, acc)

    flat_folders = []
    for f in raw["folders"]:
        walk_folders(f, flat_folders)
    for a in raw["arch"]:
        ids.new("archive", a["id"])
        for v in a["vols"]:
            ids.new("volume", v["id"])
    for r in raw["rules"]:
        ids.new("rule", r["id"])
    acc = raw["access"]
    for x in acc["roles"]:
        ids.new("role", x["id"])
    for x in acc["users"]:
        ids.new("user", x["id"])
    for x in acc["groups"]:
        ids.new("group", x["id"])
    for x in acc["cats"]:
        ids.new("catalog", x["id"])
    for x in raw["discoverySeed"]:
        ids.new("candidate", x["id"])
    ex = raw.get("extra") or {}
    for x in ex.get("scheds", []):
        ids.new("schedule", x["id"])
    for x in ex.get("dayGroups", []):
        ids.new("dayGroup", x["id"])
    for x in ex.get("objModes", []):
        ids.new("mode", x["id"])
    for x in ex.get("maintWindows", []):
        ids.new("window", x["id"])
    for x in ex.get("ruleLayouts", []):
        ids.new("layout", x)
    for x in ex.get("ruleMonitors", []):
        ids.new("monitor", x)

    # ===== Оборудование =====

    out["domains"] = [
        {"id": ids("domain", d["id"]), "name": d["name"], "license": d.get("license") or "", "online": d.get("online", True) is not False, "version": 1}
        for d in raw["domains"]
    ]
    allocated = {sid for d in raw["domains"] for sid in d["servers"]}
    servers = []
    for s in raw["servers"]:
        gpu = raw["gpu"].get(s["id"])
        servers.append({
            "id": ids("server", s["id"]),
            "name": s["name"],
            "ip": s["ip"],
            "port": s.get("port") or 20111,
            "role": SERVER_ROLE.get(s.get("role"), "node"),
            "domainId": ids("domain", raw["serverDomain"][s["id"]]),
            "allocated": s["id"] in allocated,
            "online": s.get("online", True) is not False,
            "telemetry": {k: s[k] for k in ("cpu", "ram", "net", "disk") if k in s},
            "gpu": {"model": gpu["model"], "memoryBytes": size_bytes(gpu["mem"]), "load": gpu["load"]} if gpu else None,
            "disks": [{"disk": x["disk"], "sizeBytes": size_bytes(x["size"]), "system": x["sys"]} for x in raw["disks"][s["id"]]],
            "version": 1,
        })
    out["servers"] = servers

    def device(n, parent, root_domain, owner_server):
        d = {"id": ids("device", n["id"]), "type": n["type"], "parentId": ids("device", parent["id"]) if parent else None, "domainId": root_domain}
        for k, v in n.items():
            if k in DROP:
                continue
            key = FIELD.get(k, k)
            if key in ("serverId", "archiveId"):
                v = ids("server" if key == "serverId" else "archive", v)
            elif key == "cameraId":
                v = ids("device", v)
            elif key == "recordDetectorIds":
                v = [ids("device", x) for x in v]
            elif key == "mode" and n["type"] == "email":
                v = EMAIL_MODE[v]
            elif key == "onServer":
                v = bool(v)
            d[key] = v
        if n["type"] in SERVICES or n.get("server"):
            d["serverId"] = owner_server
        if n["type"] == "det":
            d["detectorKind"] = DETECTOR_KIND[n["kind"]]
            d["sensitivity"] = int(n["sens"])
        if "size" in n:
            d["sizeBytes"] = size_bytes(n["size"])
        for k in ("lat", "lon", "azimuth"):
            if k in n:
                d[k] = num(n[k])
        if "archx" in n:
            d["extraArchives"] = [{"archiveId": ids("archive", x["arch"]), "recordMode": x.get("rec"), "stream": x.get("stream")} for x in n["archx"]]
        if "pass" in n:
            d["hasPassword"] = bool(n["pass"])
        if n["type"] == "camera":
            d["armed"] = bool(n.get("armed"))
        if n.get("ruleOff"):
            # Камера выключена правилом («Выключить камеру на время»): каким и с какого времени
            d["disabledByRuleId"] = ids("rule", n["ruleOff"]) if isinstance(n["ruleOff"], str) else None
            d["disabledByRuleAt"] = clock_to_utc(ex["ruleOffAt"], captured) if ex.get("ruleOffAt") else None
        d.setdefault("enabled", True)
        d["online"] = n.get("online", True) is not False
        d["version"] = 1
        return d

    devices = []
    by_server = {}
    for s in raw["servers"]:
        for d in s.get("devices") or []:
            by_server[d["id"]] = s["id"]
    root_of = {}
    for n, parent in services + pool:
        root_of[n["id"]] = root_of[parent["id"]] if parent else n["id"]
    for n, parent in services:
        sid = by_server[root_of[n["id"]]]
        devices.append(device(n, parent, ids("domain", raw["serverDomain"][sid]), ids("server", sid)))
    for n, parent in pool:
        devices.append(device(n, parent, ids("domain", raw["deviceDomain"][root_of[n["id"]]]), None))
    out["devices"] = devices

    domain_of_folder = {}
    for f in raw["folders"]:
        def mark(x, did):
            domain_of_folder[x["id"]] = did
            for c in x["folders"]:
                mark(c, did)
        mark(f, f["domain"])
    parent_of_folder = {c["id"]: f["id"] for f in flat_folders for c in f["folders"]}
    out["folders"] = [
        {
            "id": ids("folder", f["id"]),
            "name": f["name"],
            "domainId": ids("domain", domain_of_folder[f["id"]]),
            "parentId": ids("folder", parent_of_folder.get(f["id"])),
            "deviceIds": [ids("device", x) for x in f["items"]],
            "version": 1,
        }
        for f in flat_folders
    ]

    archives, volumes = [], []
    for a in raw["arch"]:
        archives.append({
            "id": ids("archive", a["id"]),
            "name": a["name"],
            "kind": a["kind"],
            "storage": a["storage"],
            "encrypted": bool(a["enc"]),
            "retentionDays": a["days"],
            "provider": a.get("provider"),
            "serverId": ids("server", a.get("server")),
            "domainId": ids("domain", a.get("domain")),
            "version": 1,
        })
        for v in a["vols"]:
            vol = {
                "id": ids("volume", v["id"]),
                "archiveId": ids("archive", a["id"]),
                "name": v["name"],
                "disk": v["disk"],
                "sizeBytes": size_bytes(v["size"]),
                "usedPercent": int(str(v["used"]).rstrip("%")),
                "state": v.get("state") or "ready",
                "online": v.get("online", True) is not False,
            }
            for k in ("mode", "dir", "file", "bucket", "region", "path", "keyId", "host", "port", "proto", "endpoint", "style", "account"):
                if k in v:
                    vol[k] = v[k]
            if "user" in v:
                vol["login"] = v["user"]
            vol["version"] = 1
            volumes.append(vol)
    out["archives"] = archives
    out["volumes"] = volumes

    # ===== Автоматизация =====
    out.update(automation(raw, ids, captured))

    # ===== Поиск устройств в сети =====

    # Что есть в сети домена: поиск находит эти устройства. Домен без плана видит всё (как lanSearch)
    plan = raw["foundPlan"]
    seed_ids = [x["id"] for x in raw["discoverySeed"]]
    visible = {x: [] for x in seed_ids}
    for d in raw["domains"]:
        for i in plan.get(d["id"], range(len(seed_ids))):
            visible[seed_ids[i]].append(ids("domain", d["id"]))
    out["network"] = [
        {
            "id": ids("candidate", x["id"]),
            "domainIds": visible[x["id"]],
            "type": x["type"],
            "name": x["name"],
            "ip": x["ip"],
            "port": x["port"],
            "mac": x["mac"],
            "vendor": x["vendor"],
            "model": x["model"],
            "support": x["status"],
            "login": x["user"],
            "password": x["pass"],
        }
        for x in raw["discoverySeed"]
    ]
    # Итог последнего поиска по доменам — то, что мастер показывает до нового поиска
    out["discovery"] = [
        {
            "domainId": ids("domain", did),
            "state": "done",
            "progress": 100,
            "finishedAt": captured_at,
            "candidateIds": [ids("candidate", x["id"]) for x in rows],
        }
        for did, rows in raw["found"].items()
    ]

    # ===== Права =====

    def access_key(k):
        """Ключ объекта в правах роли: устройство или хранилище — их id, видеостена — vw:<сервер>,
        макрос — macro:<правило>, плагин — plug:<код>."""
        if k.startswith("vw:"):
            return "vw:" + ids("server", k[3:])
        if k.startswith("macro:"):
            return "macro:" + ids("rule", k[6:])
        if k.startswith("plug:"):
            return k
        if ("device", k) in ids.map:
            return ids("device", k)
        return ids("archive", k)

    def folder_key(k):
        return ids("folder", k) if ("folder", k) in ids.map else ids("domain", k)

    roles = []
    for x in acc["roles"]:
        sup = x["sup"]
        roles.append({
            "id": ids("role", x["id"]),
            "name": x["n"],
            "comment": x.get("comment", ""),
            "loginSchedule": x.get("tz", 0),
            "supervision": {"roleId": ids("role", sup.get("role")), "login": bool(sup.get("login")), "export": bool(sup.get("export"))},
            "global": x["own"],
            "folderAccess": {folder_key(k): v for k, v in x["groups"].items()},
            "objectAccess": {access_key(k): v for k, v in x["objs"].items()},
        })
    cat_by_name = {c["n"]: c["id"] for c in acc["cats"]}
    users = []
    for u in acc["users"]:
        x = {
            "id": ids("user", u["id"]),
            "login": u["login"],
            "name": u["name"],
            "email": u.get("email", ""),
            "enabled": bool(u["on"]),
            "roleIds": [ids("role", r) for r in u["roles"]],
            "roleUntil": {ids("role", r): d for r, d in (u.get("until") or {}).items()},
            "lastLoginDate": u.get("last") or None,
            "expiresDate": u.get("expires") or None,
            "webSessions": u.get("web", 0),
            "mobileSessions": u.get("mobile", 0),
            "catalogId": ids("catalog", cat_by_name.get(u.get("ldap"))),
        }
        if u.get("created"):
            x["createdDate"] = u["created"]
        if u.get("synced"):
            x["syncedGroupId"] = ids("group", u["synced"])
        users.append(x)
    groups = []
    for g in acc["groups"]:
        src = g.get("src")
        groups.append({
            "id": ids("group", g["id"]),
            "name": g["n"],
            "comment": g.get("comment", ""),
            "roleIds": [ids("role", r) for r in g["roles"]],
            "rolesUntil": g.get("until") or None,
            "memberIds": [ids("user", m) for m in g["members"]],
            "source": None if not src else {
                "catalogId": ids("catalog", src["cat"]),
                "dn": src["dn"],
                "kind": src["kind"],
                "status": src["status"],
                "at": local_to_utc(src["at"]) if src.get("at") else None,
                "message": src.get("msg", ""),
            },
        })
    catalogs = [
        {
            "id": ids("catalog", c["id"]),
            "name": c["n"],
            "host": c["server"],
            "port": c["port"],
            "ssl": bool(c["ssl"]),
            "bindDn": c["bind"],
            "hasPassword": True,
            "baseDn": c["baseDn"],
            "filter": c["filter"],
            "loginAttr": c["attrLogin"],
            "nameAttr": c["attrName"],
            "importOthers": bool(c["importOthers"]),
            "schedule": c["schedule"],
            "status": c["status"],
            "lastSyncAt": local_to_utc(c["at"]) if c.get("at") else None,
            "nextSyncAt": local_to_utc(c["next"]) if c.get("next") else None,
            "durationSec": c.get("dur", 0),
            "message": c.get("msg", ""),
            "entries": [{"dn": e["dn"], "name": e["n"], "kind": e["kind"], "logins": e["logins"]} for e in c.get("avail", [])],
        }
        for c in acc["cats"]
    ]
    history = []
    for i, e in enumerate(acc["log"] + raw["cellLog"]):
        h = {"id": f"{KIND['history']}{i + 1:07d}-0000-4000-8000-000000000000", "at": local_to_utc(e["t"]), "actor": e["who"], "text": e["text"]}
        if e.get("role"):
            h["roleId"] = ids("role", e["role"])
        if e.get("roles"):
            h["roleIds"] = [ids("role", r) for r in e["roles"]]
        if e.get("user"):
            h["userId"] = ids("user", e["user"])
        if e.get("group"):
            h["groupId"] = ids("group", e["group"])
        history.append(h)
    out["access"] = {"version": 1, "roles": roles, "users": users, "groups": groups, "catalogs": catalogs, "history": history, "cellHistory": []}
    me = next(u for u in acc["users"] if u["login"] == raw["me"])
    out["me"] = {"userId": ids("user", me["id"])}

    # ===== Опции, лицензии, журнал =====

    settings = {}
    for st in raw["settings"]:
        v = st.get("value", st.get("opts", [""])[0])
        if st["id"] == "sec.2fa":
            v = TWO_FA[v]
        elif st["id"] == "sec.pwdage":
            v = int(v)
        settings[st["id"]] = v
    out["settings"] = {"version": 1, "values": settings}
    # Числа «Лицензий» в макете вписаны в разметку (sysUI): здесь они — данные
    out["licenses"] = [{"kind": "cameras", "used": 48, "total": 64}, {"kind": "acfa", "used": 3, "total": 10}]
    out["journal"] = [
        {"id": f"{KIND['journal']}{i + 1:07d}-0000-4000-8000-000000000000", "at": at, "category": JOURNAL_CATEGORY[kind], "text": text}
        for i, (at, (_, kind, text)) in enumerate(zip(clock_seq_to_utc([r[0] for r in raw["journal"]], captured), raw["journal"]))
    ]

    out["reference"] = reference(raw["refs"], ids, ex)
    out["reference"]["capabilities"] = capabilities()
    # Старый id → UUID: по нему tools/compare_screens.py сопоставляет экраны прототипов 09 и 10
    normalize.ids = {old: uid for (kind, old), uid in ids.map.items()}
    # Версия записи в API — непрозрачная строка; у самого набора version — номер формата, он остаётся числом
    def opaque(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "version" and isinstance(v, int):
                    o[k] = str(v)
                else:
                    opaque(v)
        elif isinstance(o, list):
            for x in o:
                opaque(x)
    for k, v in out.items():
        if k != "version":
            opaque(v)
    return out


def capabilities():
    """Эталонный набор — система, которая умеет весь контракт: все операции, кроме служебных /test/…,
    все виды устройств и все необязательные возможности."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api", "openapi.json"), encoding="utf-8") as f:
        spec = json.load(f)
    ops = [o["operationId"] for item in spec["paths"].values() for m, o in item.items()
           if m in ("get", "post", "put", "patch", "delete") and "test-support" not in o.get("tags", [])]
    schemas = spec["components"]["schemas"]
    return {"operations": ops, "deviceTypes": schemas["DeviceType"]["enum"], "features": schemas["Feature"]["enum"]}


# Поля действия: имя в макете → имя в контракте (to — роль у «Открыть раскладку», адрес у письма)
ACTION_FIELD = {"sub": "source", "ref": "target", "n": "preset", "dur": "duration", "after": "afterSec", "prio": "priority",
                "layout": "layoutId", "mon": "monitorId", "subj": "subject", "pulse_ms": "pulseMs", "rule": "ruleId"}
CONTROL = {"wait": "wait", "waitev": "waitEvent", "ask": "ask", "escalate": "escalate"}


def automation(raw, ids, captured):
    """Правила, их история, расписания, особые дни, режимы объекта и окна обслуживания — записями API.
    Запуски правил считает движок сервера (tools/fixture_fires.js), здесь их нет."""
    ex = raw.get("extra") or {}

    def target(ref):
        if not ref:
            return None
        if ref == "$src":
            return {"include": [], "exclude": [], "gone": [], "fromEvent": True}
        t = {"include": [], "exclude": [], "gone": [], "fromEvent": False}
        for tok in (ref[4:].split(",") if ref.startswith("set:") else [ref]):
            if tok.startswith("-"):
                t["exclude"].append(ids("device", tok[1:]))
            elif tok.startswith("gone:"):
                t["gone"].append(tok[5:].replace(";", ","))
            elif re.match(r"^(folder|server|domain):", tok):
                k, v = tok.split(":", 1)
                t["include"].append({"kind": k, "id": ids(k, v)})
            else:
                t["include"].append({"kind": "device", "id": ids("device", tok)})
        return t

    def trigger(t):
        return {"source": t["sub"], "kind": t["kind"], "target": target(t.get("ref")), "match": dict(t.get("match") or {})}

    def cond(c):
        x = {"kind": c["kind"]}
        if c["kind"] == "time":
            x["scheduleId"] = ids("schedule", c["sched"])
        elif c["kind"] == "mode":
            x["modeIds"] = [ids("mode", m) for m in c.get("modes") or []]
        else:
            x["target"] = target(c.get("ref"))
            if c["kind"] == "armed":
                x["value"] = c.get("val") is not False
        return x

    def step(a):
        if "ctl" in a:
            k = CONTROL[a["ctl"]]
            if k == "wait":
                return {"control": k, "sec": a.get("sec", 0)}
            if k == "waitEvent":
                return {"control": k, "event": trigger(a["ev"]), "sec": a.get("sec", 0), "yes": steps(a.get("yes")), "no": steps(a.get("no"))}
            if k == "ask":
                return {"control": k, "text": a.get("text", ""), "roleId": ids("role", a["to"]) if a.get("to") else None, "sec": a.get("sec", 0),
                        "default": "yes" if a.get("def") == "yes" else "no", "yes": steps(a.get("yes")), "no": steps(a.get("no"))}
            return {"control": k, "levels": [{"roleId": ids("role", l["to"]) if l.get("to") else None, "via": l.get("via", "client"), "waitMin": l.get("wait", 0)}
                                             for l in a.get("levels") or []], "stop": "reset" if a.get("stop") == "reset" else "ack"}
        x = {}
        for k, v in a.items():
            f = ACTION_FIELD.get(k, k)
            if k == "ref":
                v = target(v)
            elif k == "to" and a["action"] == "layout":
                f, v = "roleId", ids("role", v) if v else None
            elif f == "layoutId":
                v = ids("layout", v) if v else None
            elif f == "monitorId":
                v = ids("monitor", v) if v else None
            elif f == "ruleId":
                v = ids("rule", v)
            elif f in ("preset", "port", "minutes", "afterSec", "pulseMs") and isinstance(v, str) and re.match(r"^\d+$", v):
                v = int(v)
            x[f] = v
        return x

    def steps(lst):
        return [step(a) for a in lst or []]

    def content(r):
        return {
            "name": r["name"], "enabled": bool(r["on"]), "logOnly": bool(r.get("watch")), "logOnlySince": r.get("watchSince") or None,
            "start": "schedule" if r["start"] == "sched" else r["start"], "runMode": (r.get("run") or {}).get("mode", "always"),
            "operatorMenu": bool(r.get("menu")), "ratePerMinute": r["rate"], "windowSec": r["within"],
            "runAt": {"days": r["sched"]["days"], "time": r["sched"]["at"]} if r.get("sched") else None,
            "repeat": r.get("repeat") or "skip",
            "triggers": [trigger(t) for t in r["when"]], "conditions": [cond(c) for c in r.get("cond") or []], "steps": steps(r["then"]),
            "owner": r.get("owner", ""), "purpose": r.get("purpose", ""),
            "serverId": ids("server", r["server"]) if r.get("server") else None,
            "runAsRoleId": None if r.get("runAs") in (None, "", "system") else ids("role", r["runAs"]),
            "allowChain": r.get("chain") is not False,
        }

    rules = []
    for r in raw["rules"]:
        x = {"id": ids("rule", r["id"])}
        x.update(content(r))
        m = r.get("mute")
        x.update({
            "createdAt": local_to_utc(r["created"]["at"]), "createdBy": r["created"]["by"],
            "changedAt": local_to_utc(r["changed"]["at"]), "changedBy": r["changed"]["by"],
            "mute": {"since": local_to_utc(m["since"]), "until": local_to_utc(m["until"]), "by": m["by"], "reason": m.get("why", "")} if m else None,
            "order": r.get("order", 0), "version": 1,
        })
        rules.append(x)
    versions = []
    for rid, hist in (ex.get("ruleHist") or {}).items():
        for e in hist:
            versions.append({"id": ids.new("ruleVersion", f"{rid}:{e['v']}"), "ruleId": ids("rule", rid), "number": e["v"], "at": local_to_utc(e["at"]), "by": e["by"],
                             "note": {"code": "created", "params": {}} if e.get("note") == "Правило создано" else None, "rule": content(e["snap"])})

    def iv(lst):
        return [[a, b] for a, b in lst or []]

    schedules = []
    for x in ex.get("scheds", []):
        c, a = x.get("cycle") or {}, x.get("astro") or {}
        schedules.append({
            "id": ids("schedule", x["id"]), "name": x["name"], "kind": x["kind"],
            "week": [iv(d) for d in (x.get("week") or [[]] * 7)],
            "overrides": [dict({"dayGroupId": ids("dayGroup", o["g"]), "mode": o["m"]}, **({"dow": int(o["dow"])} if o.get("dow") else {}),
                               **({"intervals": iv(o["iv"])} if "iv" in o else {})) for o in x.get("ovr") or []],
            "valid": {"from": (x.get("valid") or {}).get("from", ""), "to": (x.get("valid") or {}).get("to", "")},
            "cycle": {"length": c.get("len", 4), "start": c.get("start", captured.strftime("%Y-%m-%d")), "days": [iv(d) for d in c.get("days") or []]},
            "dates": [{"date": d["d"], "intervals": iv(d["iv"])} for d in x.get("dates") or []],
            "astro": {"window": a.get("win", "night"), "offsetStartMin": a.get("off1", 0), "offsetEndMin": a.get("off2", 0),
                      "lat": a.get("lat", 55.75), "lon": a.get("lon", 37.62), "utcOffsetHours": a.get("tz", 3)},
            "builtin": bool(x.get("builtin")),
            "owner": ({"kind": "rule", "id": ids("rule", x["own"]["id"])} if x["own"].get("k") == "rule"
                      else {"kind": "maintenanceWindow", "id": ids("window", x["own"]["id"])}) if x.get("own") else None,
            "version": 1,
        })
    day_groups = [{"id": ids("dayGroup", g["id"]), "name": g["name"],
                   "rules": [{{"t": "type"}.get(k, k): v for k, v in r.items()} for r in g["rules"]], "version": 1} for g in ex.get("dayGroups", [])]
    modes = {
        "items": [{"id": ids("mode", m["id"]), "name": m["name"], "scheduleId": ids("schedule", m["sched"]) if m.get("sched") else None,
                   "system": m["id"] if m.get("sys") else "", "color": m.get("color")} for m in ex.get("objModes", [])],
        "otherwise": ids("mode", ex["objModeElse"]) if ex.get("objModeElse") else None,
        "version": 1,
    }
    windows = [{"id": ids("window", w["id"]), "name": w["name"], "scheduleId": ids("schedule", w["sched"]),
                "ruleIds": None if w["scope"] == "all" else [ids("rule", r) for r in w["scope"]], "enabled": bool(w.get("on")), "version": 1}
               for w in ex.get("maintWindows", [])]
    return {"rules": rules, "ruleVersions": versions, "ruleFires": [], "schedules": schedules, "dayGroups": day_groups,
            "modes": modes, "modeManual": None, "maintenanceWindows": windows}


def reference(r, ids=None, ex=None):
    """Справочники: коды и строение. Подписи к кодам — в интерфейсе."""
    ex = ex or {}
    opt = lambda o: o[0] if isinstance(o, list) else o
    return {
        "deviceModels": [{"vendor": v, "models": m} for v, m in r["DEVICE_MODELS"].items()],
        "deviceKinds": [{"group": g, "view": x["view"], "types": [t[0] for t in x["types"]]} for g, x in r["WIZ"].items()],
        "ipServerSubtypes": list(r["IPSUB"].keys()),
        "serviceTypes": r["SYS"],
        "supportLevels": list(r["DEVICE_STATUS_LABELS"].keys()),
        "detectorKinds": list(DETECTOR_KIND.values()),
        "recordModes": [x[0] for x in r["REC_MODES"]],
        "archiveKinds": [x[0] for x in r["ARCH_KINDS"]],
        "storageTypes": [x[0] for x in r["ARCH_STORAGE"]],
        "cloudProviders": [{"id": p, "regions": r["CLOUD_REGIONS"].get(p, [])} for p, _ in r["CLOUD_PROVIDERS"]],
        "volumeStates": list(r["VOL_STATES"].keys()),
        "deviceParams": {
            t: [
                {"key": k, "options": [PARAM_OPTION.get(o, o) for o in d]} if isinstance(d, list) else {"key": k, "default": d}
                for k, _, d in ps
            ]
            for t, ps in r["DEV_PARAMS"].items()
        },
        "ruleTriggers": [
            {"source": t["sub"], "kind": t["kind"], "match": [{"id": m["id"], "options": m["opts"]} for m in t["match"]]}
            for t in r["TRIGGER_KINDS"]
        ],
        "ruleActions": [
            {
                "source": a["sub"],
                "action": a["action"],
                "deviceTypes": a.get("devTypes", []),
                "fields": [
                    dict({"id": "roleId" if f["id"] == "to" and a["action"] == "layout" else ACTION_FIELD.get(f["id"], f["id"])},
                         **({"options": [ids("monitor", o) if f["id"] == "mon" else opt(o) for o in f["opts"]]} if f.get("opts") else {}),
                         **({"optional": True} if "необязательно" in f["label"] or f.get("req") is False else {}))
                    for f in a["fields"]
                ],
            }
            for a in r["ACTION_KINDS"]
        ],
        "ruleConditions": [{"kind": c["kind"], "deviceTypes": c.get("devTypes", [])} for c in r.get("COND_KINDS", [])],
        "ruleControls": [{"control": CONTROL[c["ctl"]], "branches": [b[0] for b in c.get("br", [])]} for c in r.get("CTL_KINDS", [])],
        "layouts": [{"id": ids("layout", x), "name": x} for x in ex.get("ruleLayouts", [])],
        "monitors": [{"id": ids("monitor", x), "name": x} for x in ex.get("ruleMonitors", [])],
        "access": {
            "features": [f[0] for f in r["ACC_FEATURES"]],
            "levels": {k: [x[0] for x in v] for k, v in r["ACC_LV"].items()},
            "defaults": [{"key": d[0], "levels": d[2]} for d in r["ACC_DEFS"]],
            "globals": [{"key": g[0], "levels": g[2]} for g in r["ACC_GLOB"]],
            "folderFields": [f[0] for f in r["ACC_GF"]],
            "fieldDefaults": r["ACC_GF_DEF"],
            "visibleFrom": r["ACC_VIS"],
            "restrictions": [x[0] for x in r["ACC_RESTR"]],
            "plugins": [x[0] for x in r["ACC_PLUGINS"]],
            "roleTemplates": [{"id": k, "rights": v[1]} for k, v in r["ACC_TPL"].items()],
            "loginSchedules": list(range(len(r["ACC_TZ"]))),
            "syncTimezones": list(r["ACC_TZN"].keys()),
            "staleDays": r["ACC_STALE"],
            "expiringSoonDays": r["ACC_SOON"],
            "passwordPolicy": {"minLength": 8, "letter": True, "digit": True, "notLogin": True},
        },
        "limits": {"ipScanMax": r["IP_SCAN_LIMIT"], "defaultServerPort": 20111},
    }
