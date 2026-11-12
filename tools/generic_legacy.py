"""Старые разделы набора ⇄ склад объектов: domains, servers, devices, folders, archives, volumes ⇄ units.

Эталонный набор api/fixtures/demo.json хранит только units, старых путей (/devices…) в контракте нет. Инструменты и тесты,
которым удобнее записи таблиц (выборки набора, fixturePatch старыми разделами), выводят их из units: tables_from_units —
обратное units_from_tables. Тот же перевод в api/server.js (Legacy): записи старых таблиц там — представления объектов склада.

- units_from_tables(base) — объекты из записей старых разделов (profile_fixture.py);
- tables_from_units(units) — записи старых разделов из объектов (check_api.py, profile_fixture.py);
- with_tables(fx) — набор с выведенными старыми разделами, если их в нём нет.
Порядок ключей записи — свой, не исходный: сравнивать записи — по значению.
"""
import copy

OLD_TABLES = ("domains", "servers", "devices", "folders", "archives", "volumes")
# Виды устройств — по одному на значение DeviceType
DEVICE_TYPES = ("camera", "ipsrv", "channel", "mic", "spk", "sensor", "relay", "storage", "det", "eventsrc", "acfa", "acfa_sensor", "acfa_lock",
                "acfa_fence", "export", "email", "sms")
# Поля записи, которые у Unit свои: uid, kind, parentId, domainId, name, version
UNIT_FIELDS = {"id", "type", "kind", "parentId", "domainId", "name", "version"}
# Состояние, которое система назначает или измеряет сама → status.observed (online → status.link)
OBSERVED = {
    "devices": ["fault", "faultText", "licenseExceeded", "recordState", "recordReason", "replicaLagSec", "armed", "disabledByRuleId",
                "disabledByRuleAt", "archiveJobs", "direct", "recordingTarget", "detectorKinds", "derived"],
    "servers": ["telemetry", "gpu", "disks", "class", "fingerprint", "webCertificate", "webReservedPorts"],
    "domains": ["stateSummary"],
    "volumes": ["usedPercent", "shrinkPendingBytes", "heldBy", "incidentsLost", "incidentsAtRisk"],
    "archives": [],
    "folders": [],
}
# Поля записи, которые в склад не идут: потоки — отдельные объекты, папки — Unit.folders, hasPassword — Unit.secrets
DROPPED = {"online", "streams", "folderIds", "hasPassword", "hasSecret", "deviceIds", "writableFields"}
# Поля потока камеры, которые идут в свойства объекта stream (код потока — streamId)
STREAM_FIELDS = ("res", "fps", "codec", "width", "height", "resOptions")
# Флаги секретов записи → Unit.secrets
SECRET_FLAGS = {"devices": (("password", "hasPassword"),), "volumes": (("password", "hasPassword"), ("secret", "hasSecret"))}


def table_of(kind):
    """Старая таблица вида; None — вида в старых таблицах нет (поток, незнакомые виды)."""
    if kind in DEVICE_TYPES:
        return "devices"
    if kind.startswith("archive."):
        return "archives"
    return {"domain": "domains", "server": "servers", "folder": "folders", "volume": "volumes"}.get(kind)


def link(rec):
    return "online" if rec.get("online", True) else "offline"


def status(rec, table):
    s = {"link": link(rec)} if "online" in rec else {}
    observed = {k: copy.deepcopy(rec[k]) for k in OBSERVED[table] if k in rec}
    if observed:
        s["observed"] = observed
    return s


def unit(uid, kind, parent, domain, name, version, props, st=None, folders=None, secrets=None):
    u = {"uid": uid, "kind": kind, "parentId": parent, "domainId": domain, "name": name}
    if folders:
        u["folders"] = folders
    u["version"] = version
    u["properties"] = props
    if secrets:
        u["secrets"] = secrets
    if st:
        u["status"] = st
    return u


def stream_uid(camera_uid, n):
    """uid потока: uid камеры с номером потока во второй группе (30000013-0001-…)."""
    return f"{camera_uid[:9]}{n:04d}{camera_uid[13:]}"


def props_of(rec, table, extra=()):
    return {k: copy.deepcopy(rec[k]) for k in rec if k not in UNIT_FIELDS | DROPPED | set(extra) | set(OBSERVED[table])}


def secrets_of(rec, table):
    return {name: True for name, flag in SECRET_FLAGS.get(table, ()) if rec.get(flag)}


def units_from_tables(base):
    """Объекты склада из старых разделов base: uid = id записи; потоки камер — объекты stream после устройств."""
    units = []
    for r in base["domains"]:
        units.append(unit(r["id"], "domain", None, None, r["name"], r["version"], props_of(r, "domains"), status(r, "domains")))
    for r in base["servers"]:
        units.append(unit(r["id"], "server", None, r["domainId"], r["name"], r["version"], props_of(r, "servers"), status(r, "servers")))
    for r in base["folders"]:
        units.append(unit(r["id"], "folder", r["parentId"], r["domainId"], r["name"], r["version"], {}))
    server_domain = {s["id"]: s["domainId"] for s in base["servers"]}
    for r in base["archives"]:
        dom = r["domainId"] or server_domain[r["serverId"]]
        units.append(unit(r["id"], f"archive.{r['kind']}", r["serverId"], dom, r["name"], r["version"], props_of(r, "archives", {"serverId"}), status(r, "archives")))
    archive_domain = {u["uid"]: u["domainId"] for u in units if u["kind"].startswith("archive.")}
    for r in base["volumes"]:
        units.append(unit(r["id"], "volume", r["archiveId"], archive_domain[r["archiveId"]], r["name"], r["version"], props_of(r, "volumes", {"archiveId"}),
                          status(r, "volumes"), secrets=secrets_of(r, "volumes")))
    member = {}
    for f in base["folders"]:
        for d in f["deviceIds"]:
            member.setdefault(d, []).append(f["id"])
    streams = []
    for r in base["devices"]:
        units.append(unit(r["id"], r["type"], r["parentId"], r["domainId"], r["name"], r["version"], props_of(r, "devices"), status(r, "devices"),
                          member.get(r["id"]), secrets_of(r, "devices")))
        # Что правится у записи сейчас (writableFields) — Unit.writable
        if "writableFields" in r:
            units[-1]["writable"] = copy.deepcopy(r["writableFields"])
        for n, s in enumerate(r.get("streams", []), 1):
            sp = {"streamId": s["id"]}
            sp.update({k: copy.deepcopy(s[k]) for k in STREAM_FIELDS if k in s})
            streams.append(unit(stream_uid(r["id"], n), "stream", r["id"], r["domainId"], s["name"], r["version"], sp, {"link": link(s)}))
    return units + streams


def tables_from_units(units):
    """Записи старых разделов из объектов склада — обратное units_from_tables."""
    kids, members = {}, {}
    for u in units:
        if u["kind"] == "stream":
            kids.setdefault(u["parentId"], []).append(u)
        # Состав папки в старой записи — только устройства: объекты незнакомых видов старые пути не знают
        if u["kind"] in DEVICE_TYPES:
            for f in u.get("folders", []):
                members.setdefault(f, []).append(u["uid"])
    out = {t: [] for t in OLD_TABLES}
    for u in units:
        t = table_of(u["kind"])
        if t:
            out[t].append(record(u, t, kids, members))
    return out


def record(u, t, kids, members):
    st = u.get("status") or {}
    online = {"online": st["link"] == "online"} if "link" in st else {}
    props = copy.deepcopy(u["properties"])
    observed = copy.deepcopy(st.get("observed", {}))
    flags = {flag: True for name, flag in SECRET_FLAGS.get(t, ()) if (u.get("secrets") or {}).get(name)}
    head = {"id": u["uid"]}
    if t == "domains":
        return dict(head, name=u["name"], **props, **online, **observed, version=u["version"])
    if t == "servers":
        return dict(head, name=u["name"], domainId=u["domainId"], **props, **online, **observed, version=u["version"])
    if t == "folders":
        return dict(head, name=u["name"], domainId=u["domainId"], parentId=u["parentId"], deviceIds=members.get(u["uid"], []), version=u["version"])
    if t == "archives":
        return dict(head, name=u["name"], kind=u["kind"][len("archive."):], **props, serverId=u["parentId"],
                    domainId=None if u["parentId"] else u["domainId"], version=u["version"])
    if t == "volumes":
        return dict(head, archiveId=u["parentId"], name=u["name"], **props, **online, **observed, **flags, version=u["version"])
    rec = dict(head, type=u["kind"], parentId=u["parentId"], domainId=u["domainId"], name=u["name"], **online, **props, **observed, **flags, version=u["version"])
    if "writable" in u:
        rec["writableFields"] = copy.deepcopy(u["writable"])
    streams = [stream_record(s) for s in kids.get(u["uid"], [])]
    if streams:
        rec["streams"] = streams
    return rec


def stream_record(s):
    p = s["properties"]
    out = {"id": p["streamId"], "name": s["name"]}
    out.update({k: copy.deepcopy(v) for k, v in p.items() if k != "streamId"})
    if "link" in (s.get("status") or {}):
        out["online"] = s["status"]["link"] == "online"
    return out


def with_tables(fx):
    """Набор со старыми разделами: если их нет, а units есть — выведенными из units. Исходный набор не меняется."""
    if "units" not in fx or all(t in fx for t in OLD_TABLES):
        return fx
    out = dict(fx)
    for t, recs in tables_from_units(fx["units"]).items():
        out.setdefault(t, recs)
    return out
