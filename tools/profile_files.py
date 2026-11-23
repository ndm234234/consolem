#!/usr/bin/env python3
"""Файлы профилей: api/profiles/<имя>.json — разбор, версии, запись для GET /kinds и таблица для людей.

Модуль чистый: читает только папку профилей, git не трогает. Его используют tools/build_api.py
(сборка раздела profiles в demo.json и таблиц) и tools/check_api.py (проверка профилей); самопроверка —
tools/check_profile_files.py.

Формат файла: ключи id, version, label, owner, reviewers, uses, properties, status (необязательный),
apis (необязательный), changes. Версия — «M.m», M равно номеру после «/» в id. В строке changes
необязателен ключ removed — список снятых полей (решение владельца О2). У поля необязателен ключ absent:
"unsupported" — «нет значения — у сервера нет такой возможности»: особый экран консоли прячет такое поле у объекта
без значения (ответ w2c на запрос 154325Z, п. 3.1). Метки знакомых профилей консоль получает из
window.CONSOLEM_PROFILE_ABSENT в api/fixture.js (profile_absent_js).
"""
import json
import os
import re

PROFILES_DIR = "profiles"
FILE_KEYS = ("id", "version", "label", "owner", "reviewers", "uses", "properties", "status", "apis", "changes")
REQUIRED_KEYS = tuple(k for k in FILE_KEYS if k not in ("status", "apis"))
SERVICE_KEYS = ("_file",)
FIELD_KEYS = ("schema", "meaning", "since")
OPTIONAL_FIELD_KEYS = ("absent",)
ABSENT_VALUES = ("unsupported",)
CHANGE_KEYS = ("version", "what", "removed")

_VERSION = re.compile(r"^[0-9]+\.[0-9]+$")
_ID = re.compile(r"^[A-Za-z0-9_.-]+/[0-9]+$")


def parse_version(v):
    """«1.5» → (1, 5). Всё, кроме «M.m», — ValueError."""
    if not isinstance(v, str) or not _VERSION.match(v):
        raise ValueError(f"версия {v!r} — нужно M.m, например 1.5")
    major, minor = v.split(".")
    return int(major), int(minor)


def major_of(pid):
    """«vms.camera/1» → 1."""
    return int(pid.rsplit("/", 1)[1])


def profile_name(pid):
    """«vms.camera/1» → «vms.camera»."""
    return pid.rsplit("/", 1)[0]


def file_name(pid):
    """Имя файла профиля. Старшая версия 1 — «vms.camera/1» → «vms.camera.json»;
    старшая N ≥ 2 лежит рядом со старой — «vms.camera/2» → «vms.camera.2.json»."""
    major = major_of(pid)
    return profile_name(pid) + (".json" if major == 1 else f".{major}.json")


_FILE_MAJOR = re.compile(r"^(.+)\.([0-9]+)\.json$")


def id_of_file(name):
    """Имя файла → id, который в нём ожидают: «vms.camera.json» → «vms.camera/1», «vms.camera.2.json» →
    «vms.camera/2». Не файл профиля (не .json) — None. «<имя>.1.json» тоже даёт «/1», но file_name для него
    иное имя, и profile_problems отклонит такой файл."""
    if not name.endswith(".json"):
        return None
    m = _FILE_MAJOR.match(name)
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    return f"{name[:-5]}/1"


def load_profiles(api_dir):
    """Все *.json папки <api_dir>/profiles по имени файла; в каждом документе ключ _file — имя файла.
    Нет папки — пустой список. Сломанный файл — ValueError с его именем."""
    folder = os.path.join(api_dir, PROFILES_DIR)
    if not os.path.isdir(folder):
        return []
    docs = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(folder, name)
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except ValueError as e:
            raise ValueError(f"{PROFILES_DIR}/{name}: не читается как JSON — {e}") from e
        if not isinstance(doc, dict):
            raise ValueError(f"{PROFILES_DIR}/{name}: в файле должен быть объект")
        doc["_file"] = name
        docs.append(doc)
    return docs


def _str(v):
    return isinstance(v, str) and v.strip() != ""


def _ver(v):
    try:
        return parse_version(v)
    except ValueError:
        return None


def _field_problems(section, name, field, version, major, versions):
    where = f"{section}.{name}"
    if not isinstance(field, dict):
        return [f"{where}: нужен объект {{schema, meaning, since}}"]
    out = []
    extra = sorted(set(field) - set(FIELD_KEYS) - set(OPTIONAL_FIELD_KEYS))
    missing = [k for k in FIELD_KEYS if k not in field]
    if extra:
        out.append(f"{where}: незнакомые ключи {', '.join(extra)}")
    if missing:
        out.append(f"{where}: нет ключей {', '.join(missing)}")
    sch = field.get("schema")
    if "schema" in field and not (isinstance(sch, dict) and "type" in sch):
        out.append(f"{where}: schema — объект с type")
    if "meaning" in field and not _str(field["meaning"]):
        out.append(f"{where}: meaning пустой")
    if "absent" in field and field["absent"] not in ABSENT_VALUES:
        out.append(f"{where}: absent {field['absent']!r} — можно только {', '.join(ABSENT_VALUES)}")
    if "since" in field:
        since = _ver(field["since"])
        if since is None:
            out.append(f"{where}: since {field['since']!r} — нужно M.m")
        else:
            if major is not None and since[0] != major:
                out.append(f"{where}: since {field['since']} — старшая версия не {major}")
            if version is not None and since > version:
                out.append(f"{where}: since {field['since']} новее version {version[0]}.{version[1]}")
            if field["since"] not in versions:
                out.append(f"{where}: since {field['since']}, а строки с такой версией в changes нет")
    return out


def profile_problems(doc):
    """Формат одного файла профиля. Пустой список — файл в порядке."""
    out = []
    keys = [k for k in doc if k not in SERVICE_KEYS]
    for k in keys:
        if k not in FILE_KEYS:
            out.append(f"ключ {k}: незнакомый, можно {', '.join(FILE_KEYS)}")
    for k in REQUIRED_KEYS:
        if k not in doc:
            out.append(f"нет ключа {k}")
    pid = doc.get("id")
    major = None
    if "id" in doc:
        if not (isinstance(pid, str) and _ID.match(pid)):
            out.append(f"id {pid!r}: нужно <имя>/<старшая версия>, например vms.camera/1")
        else:
            major = major_of(pid)
            if "_file" in doc and doc["_file"] != file_name(pid):
                out.append(f"имя файла {doc['_file']}: для {pid} нужно {file_name(pid)}")
    version = None
    if "version" in doc:
        version = _ver(doc["version"])
        if version is None:
            out.append(f"version {doc['version']!r}: нужно M.m")
        elif major is not None and version[0] != major:
            out.append(f"version {doc['version']}: старшая версия не та, что в id ({major})")
    for k in ("label", "owner"):
        if k in doc and not _str(doc[k]):
            out.append(f"{k}: нужна непустая строка")
    if "reviewers" in doc:
        r = doc["reviewers"]
        if not (isinstance(r, list) and r and all(_str(x) for x in r)):
            out.append("reviewers: нужен непустой список непустых строк")

    versions = set()
    ch = doc.get("changes")
    if "changes" in doc:
        if not (isinstance(ch, list) and ch):
            out.append("changes: нужен непустой список строк {version, what}")
        else:
            prev = None
            for i, row in enumerate(ch):
                w = f"changes[{i}]"
                if not isinstance(row, dict):
                    out.append(f"{w}: нужен объект {{version, what}}")
                    continue
                extra = sorted(set(row) - set(CHANGE_KEYS))
                if extra:
                    out.append(f"{w}: незнакомые ключи {', '.join(extra)}")
                if "version" not in row or "what" not in row:
                    out.append(f"{w}: нужны ключи version и what")
                if "what" in row and not _str(row["what"]):
                    out.append(f"{w}: what пустой")
                if "removed" in row and not (isinstance(row["removed"], list) and all(_str(x) for x in row["removed"])):
                    out.append(f"{w}: removed — список непустых строк")
                v = _ver(row.get("version"))
                if v is None:
                    out.append(f"{w}: version {row.get('version')!r} — нужно M.m")
                    continue
                versions.add(row["version"])
                if prev is not None and not v < prev:
                    out.append(f"changes[{i}]: версии идут строго по убыванию, {row['version']} не меньше предыдущей")
                prev = v
            if _ver(ch[0].get("version") if isinstance(ch[0], dict) else None) is not None and version is not None \
                    and _ver(ch[0]["version"]) != version:
                out.append(f"первая строка changes — {ch[0]['version']}, а version {doc['version']}")

    for section in ("properties", "status"):
        if section in doc:
            if not isinstance(doc[section], dict):
                out.append(f"{section}: нужен объект {{имя: {{schema, meaning, since}}}}")
                continue
            for name, field in doc[section].items():
                out += _field_problems(section, name, field, version, major, versions)

    if "uses" in doc:
        seen = set()
        if not isinstance(doc["uses"], list):
            out.append("uses: нужен список {id, version}")
        else:
            for i, u in enumerate(doc["uses"]):
                w = f"uses[{i}]"
                if not (isinstance(u, dict) and set(u) == {"id", "version"}):
                    out.append(f"{w}: нужен объект ровно с ключами id и version")
                    continue
                uid, uver = u["id"], u["version"]
                if not (isinstance(uid, str) and _ID.match(uid)):
                    out.append(f"{w}: id {uid!r} — нужно <имя>/<старшая версия>")
                    continue
                if uid in seen:
                    out.append(f"{w}: {uid} повтор")
                seen.add(uid)
                if uid == pid:
                    out.append(f"{w}: профиль использует сам себя ({uid})")
                uv = _ver(uver)
                if uv is None:
                    out.append(f"{w}: version {uver!r} — нужно M.m")
                elif uv[0] != major_of(uid):
                    out.append(f"{w}: версия {uver} не из старшей версии {uid}")
    if "apis" in doc:
        a = doc["apis"]
        if not (isinstance(a, list) and all(_str(x) for x in a)):
            out.append("apis: нужен список непустых строк")
        elif len(set(a)) != len(a):
            out.append("apis: повтор")
    return out


def profile_wire(doc):
    """Запись профиля для GET /kinds и раздела profiles в demo.json."""
    w = {"id": doc["id"], "label": {"key": f"profile.{doc['id']}", "text": doc["label"], "lang": "ru"},
         "version": doc["version"]}
    if doc.get("uses"):
        w["uses"] = [{"id": u["id"], "version": u["version"]} for u in doc["uses"]]
    w["properties"] = list(doc.get("properties") or {})
    if doc.get("status"):
        w["status"] = list(doc["status"])
    if doc.get("apis"):
        w["apis"] = list(doc["apis"])
    return w


def type_sig(schema):
    """Тип поля для сравнения: (множество типов, подпись items или None, x-ref или None)."""
    t = schema.get("type")
    types = frozenset(t if isinstance(t, list) else [t] if t is not None else [])
    items = schema.get("items")
    ref = schema.get("x-ref")
    return (types, type_sig(items) if isinstance(items, dict) else None,
            (tuple(sorted(ref.get("implements") or [])), tuple(sorted(ref.get("kinds") or []))) if isinstance(ref, dict) else None)


def type_text(schema):
    """Тип словами для таблицы."""
    t = schema.get("type")
    types = t if isinstance(t, list) else [t] if t is not None else []
    parts = []
    for x in types:
        if x == "array":
            items = schema.get("items")
            text = "массив " + type_text(items) if isinstance(items, dict) else "массив"
            if "maxItems" in schema:
                text += f", до {schema['maxItems']}"
            parts.append(text)
        else:
            parts.append(x)
    text = " | ".join(parts)
    if schema.get("enum"):
        text += ": " + ", ".join(f"`{v}`" for v in schema["enum"])
    ref = schema.get("x-ref")
    if isinstance(ref, dict):
        if ref.get("implements"):
            text += " — uid (" + ", ".join(f"`{p}`" for p in ref["implements"]) + ")"
        elif ref.get("kinds"):
            text += " — uid (" + ", ".join(ref["kinds"]) + ")"
    if schema.get("readOnly"):
        text += " (только чтение)"
    if schema.get("writeOnly"):
        text += " (секрет)"
    return text


def table_name(pid):
    """Имя таблицы профиля: «vms.camera/1» → «vms.camera.md», «vms.camera/2» → «vms.camera.2.md»."""
    return file_name(pid)[:-len(".json")] + ".md"


def profile_absent(doc):
    """Поля профиля с absent: "unsupported" (свойства и состояние), в порядке файла."""
    return [n for sec in ("properties", "status") for n, f in (doc.get(sec) or {}).items()
            if isinstance(f, dict) and f.get("absent") == "unsupported"]


def profile_absent_js(docs):
    """Строка для api/fixture.js: window.CONSOLEM_PROFILE_ABSENT={профиль: [поля]} — только профили с метками."""
    m = {d["id"]: profile_absent(d) for d in sorted(docs, key=lambda d: d["id"]) if profile_absent(d)}
    return "window.CONSOLEM_PROFILE_ABSENT=" + json.dumps(m, ensure_ascii=False, separators=(",", ":")) + ";\n"


def _cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def _table(fields):
    if not fields:
        return ["Своих свойств нет.", ""]
    rows = ["| Свойство | Тип | Смысл | С версии |", "|---|---|---|---|"]
    for name, f in fields.items():
        meaning = f["meaning"] + (" Нет значения — у сервера нет такой возможности: особый экран поле не показывает (`absent`)."
                                  if f.get("absent") == "unsupported" else "")
        rows.append(f"| `{name}` | {_cell(type_text(f['schema']))} | {_cell(meaning)} | {f['since']} |")
    return rows + [""]


def render_md(doc, kinds):
    """Таблица профиля для людей: api/profiles/<имя>.md."""
    pid = doc["id"]
    uses = doc.get("uses") or []
    lines = [f"<!-- Собрано tools/build_api.py из api/profiles/{file_name(pid)} — руками не править -->",
             f"# `{pid}` — {doc['label']}", "",
             f"Версия {doc['version']} · ведёт: {doc['owner']} · смотрят правку: {', '.join(doc['reviewers'])}", "",
             "Использует: " + (", ".join(f"`{u['id']}` с {u['version']}" for u in uses) if uses else "—"), ""]
    kinds_line = "Виды эталонного набора: " + ", ".join(f"`{k}`" for k in kinds) + "."
    if doc.get("apis"):
        kinds_line += " Предметные пути: " + ", ".join(f"`/units/{{uid}}/{a}`" for a in doc["apis"]) + "."
    lines += [kinds_line, "", "## Свойства", ""]
    lines += _table(doc.get("properties") or {})
    lines += ["## Состояние (`status.observed`)", ""]
    lines += _table(doc.get("status") or {})
    lines += ["## Изменения", "", "| Версия | Что |", "|---|---|"]
    for row in doc["changes"]:
        what = row["what"] + (f" Снято: {', '.join(f'`{r}`' for r in row['removed'])}." if row.get("removed") else "")
        lines.append(f"| {row['version']} | {_cell(what)} |")
    return "\n".join(lines) + "\n"


# ── Проверки профилей 1–3: чистые функции, git не трогают ──
def type_fits(kind_schema, profile_schema, cut=False):
    """Тип поля вида вмещается в тип поля профиля: типы вида ⊆ типов профиля,
    у массива то же для items, x-ref равны. cut — набор без целевых видов ссылки снял x-ref
    и поставил readOnly (profile_fixture.gone_ref): такое поле принимается."""
    kt, ki, kr = type_sig(kind_schema)
    pt, pi, pr = type_sig(profile_schema)
    gone = cut and kr is None and pr is not None and not pr[0] and kind_schema.get("readOnly") is True
    if not kt <= pt or (kr != pr and not gone):
        return False
    if ki is not None and pi is not None:
        return type_fits(kind_schema["items"], profile_schema["items"], cut)
    return True


def kind_problems(docs, kinds, cut_refs=False, kind_codes=()):
    """Проверка 1: у каждого вида с профилем из docs в implements каждое поле профиля,
    которое есть в схеме вида, проходит type_fits. cut_refs (наборы, кроме эталона): ссылку по kinds,
    чьих видов нет среди kind_codes, набор мог снять (type_fits, cut). Есть ли поле хоть у одного вида — смотрит check_units."""
    by_id = {d["id"]: d for d in docs}
    out = []
    for kind in kinds:
        props = (kind.get("schema") or {}).get("properties") or {}
        for pid in kind.get("implements") or []:
            doc = by_id.get(pid)
            if not doc:
                continue
            for name, field in (doc.get("properties") or {}).items():
                if name not in props:
                    continue
                ksig, psig = type_sig(props[name]), type_sig(field["schema"])
                _, _, pref = psig
                cut = bool(cut_refs and pref and not pref[0] and pref[1] and not set(pref[1]) & set(kind_codes))
                if not type_fits(props[name], field["schema"], cut):
                    what = "x-ref не тот" if ksig[2] != psig[2] else "тип шире, чем в профиле"
                    out.append(f"вид {kind['kind']}, профиль {pid}, поле {name}: {what} "
                               f"(у вида {type_text(props[name])}, у профиля {type_text(field['schema'])})")
    return out


def fixture_profile_problems(fixture_profiles, docs, whole):
    """Профили набора против файлов. whole (эталонный набор): запись равна profile_wire(файла), id те же.
    Иначе: id есть среди файлов, version и label те же, uses — как в файле, но только профили, что есть в наборе,
    properties, status, apis — подмножества."""
    by_id = {d["id"]: d for d in docs}
    out = []
    ids = set()
    present = {r.get("id") for r in fixture_profiles}
    for rec in fixture_profiles:
        pid = rec.get("id")
        ids.add(pid)
        doc = by_id.get(pid)
        if doc is None:
            out.append(f"профиль {pid} набора: файла профиля нет")
            continue
        wire = profile_wire(doc)
        if whole:
            if rec != wire:
                diff = sorted(k for k in set(rec) | set(wire) if rec.get(k) != wire.get(k))
                out.append(f"профиль {pid} эталона не равен файлу {doc.get('_file', '')}: отличаются {', '.join(diff)}")
            continue
        if rec.get("version") != wire["version"]:
            out.append(f"профиль {pid} набора: version {rec.get('version')}, в файле {wire['version']}")
        if rec.get("label") != wire["label"]:
            out.append(f"профиль {pid} набора: label {rec.get('label')}, в файле {wire['label']}")
        want = [u for u in wire.get("uses") or [] if u["id"] in present]
        if (rec.get("uses") or []) != want:
            out.append(f"профиль {pid} набора: uses {rec.get('uses') or []}, по файлу и профилям набора {want}")
        for key in ("properties", "status", "apis"):
            extra = sorted(set(rec.get(key) or []) - set(wire.get(key) or []))
            if extra:
                out.append(f"профиль {pid} набора: в {key} лишнее {', '.join(extra)}, в файле этого нет")
    if whole:
        for pid in sorted(set(by_id) - ids):
            out.append(f"профиль {pid} есть в файлах, а в эталоне его нет")
    return out


def history_problems(cur, base):
    """Проверка 2: файл против того же файла в origin/main (base; None — профиль новый).
    При одной старшей версии: версия не ниже; у старого поля тот же тип и since; поле можно снять только
    младшей версией с записью removed в changes (решение О2), путь снять нельзя; новое поле или путь требует новой младшей версии, а since нового поля — новее версии в base."""
    if base is None:
        return []
    pid = cur["id"]
    cm, bm = major_of(cur["id"]), major_of(base["id"])
    if cm < bm:
        return [f"профиль {pid}: старшая версия {cm} меньше, чем в origin/main ({bm})"]
    if cm > bm:
        return [f"профиль {pid}: в origin/main файл был {profile_name(pid)}/{bm}, а здесь в нём {pid}; старшую версию кладут рядом: "
                f"{file_name(pid)}, а {file_name(base['id'])} остаётся"]
    cv, bv = parse_version(cur["version"]), parse_version(base["version"])
    if cv < bv:
        return [f"профиль {pid}: версия {cur['version']} ниже, чем в origin/main ({base['version']})"]
    grew = cv > bv
    out = []
    key = lambda d: sorted(json.dumps(u, sort_keys=True) for u in d.get("uses") or [])
    if key(cur) != key(base) and not grew:
        out.append(f"профиль {pid}: uses изменён без новой младшей версии (в origin/main {base['version']})")
    removed = {r for row in cur.get("changes") or [] if row.get("version") == cur["version"] for r in row.get("removed") or []}
    for name in sorted(removed):
        if name in (cur.get("properties") or {}) or name in (cur.get("status") or {}):
            out.append(f"профиль {pid}: поле {name} названо в removed, а осталось в профиле")
    for section in ("properties", "status"):
        old, new = base.get(section) or {}, cur.get(section) or {}
        for name, f in old.items():
            if name not in new:
                if name in removed and grew:
                    continue
                if name in removed:
                    out.append(f"профиль {pid}: поле {name} ({section}) снято без новой младшей версии (в origin/main {base['version']})")
                else:
                    out.append(f"профиль {pid}: поле {name} ({section}) снято без записи removed в changes с версией файла {cur['version']}")
                continue
            if type_sig(new[name]["schema"]) != type_sig(f["schema"]):
                out.append(f"профиль {pid}: у поля {name} поменялся тип при той же старшей версии")
            if new[name]["since"] != f["since"]:
                out.append(f"профиль {pid}: у поля {name} поменялся since ({f['since']} → {new[name]['since']})")
            if new[name].get("absent") != f.get("absent") and not grew:
                out.append(f"профиль {pid}: у поля {name} поменялся absent без новой младшей версии (в origin/main {base['version']})")
        for name, f in new.items():
            if name in old:
                continue
            if not grew:
                out.append(f"профиль {pid}: новое поле {name} без новой младшей версии (в origin/main {base['version']})")
            elif _ver(f.get("since")) is not None and _ver(f["since"]) <= bv:
                out.append(f"профиль {pid}: since {f['since']} у нового поля {name} не новее версии в origin/main ({base['version']})")
    old_apis, new_apis = base.get("apis") or [], cur.get("apis") or []
    for a in old_apis:
        if a not in new_apis:
            out.append(f"профиль {pid}: путь {a} снят при той же старшей версии")
    for a in new_apis:
        if a not in old_apis and not grew:
            out.append(f"профиль {pid}: новый путь {a} без новой младшей версии (в origin/main {base['version']})")
    return out


def removed_file_problems(base_names, cur_names):
    """Файл профиля есть в origin/main, а теперь его нет: снят профиль, а значит, снята старшая версия."""
    return [f"файл профиля {n} есть в origin/main, а здесь его нет: снять старшую — запрос к reviewers"
            for n in sorted(set(base_names) - set(cur_names))]


def _refs(schema, found):
    ref = schema.get("x-ref")
    if isinstance(ref, dict):
        found.update(ref.get("implements") or [])
    if isinstance(schema.get("items"), dict):
        _refs(schema["items"], found)
    for sub in (schema.get("properties") or {}).values():
        if isinstance(sub, dict):
            _refs(sub, found)


def uses_problems(docs):
    """Проверка 3: каждая зависимость из uses — файл с тем же id и версией не ниже указанной;
    каждый x-ref.implements в полях профиля, кроме своего id, назван в uses."""
    by_id = {d["id"]: d for d in docs}
    out = []
    for doc in docs:
        pid = doc["id"]
        used = {u["id"] for u in doc.get("uses") or []}
        for u in doc.get("uses") or []:
            uid = u["id"]
            dep = by_id.get(uid)
            if dep is None:
                others = sorted(i for i in by_id if profile_name(i) == profile_name(uid))
                if others:
                    out.append(f"профиль {pid}: зависимость {uid}, а есть только {', '.join(others)} — проверить зависимых")
                else:
                    out.append(f"профиль {pid}: зависимость {uid} — файла профиля нет")
            elif parse_version(dep["version"]) < parse_version(u["version"]):
                out.append(f"профиль {pid}: зависимость {uid} с {u['version']}, а в файле {dep['version']}")
        for section in ("properties", "status"):
            for name, f in (doc.get(section) or {}).items():
                refs = set()
                _refs(f["schema"], refs)
                for r in sorted(refs - used - {pid}):
                    out.append(f"профиль {pid}, поле {name}: x-ref на {r}, а в uses строки для него нет")
    return out
